import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { createLogger } from "@/lib/logger";
import { withRequestContext } from "@/lib/with-request-context";

const log = createLogger("api/prompt");
import { z } from "zod";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { auditLog } from "@/lib/helpers/audit";
import {
  gcsPromptGet,
  gcsPromptPut,
  type PromptConfig,
} from "@/lib/helpers/gcs-config";
import { inspectContainer, dockerRecreateWithEnv } from "@/lib/helpers/docker-sock";

export const dynamic = "force-dynamic";

const DOCKER_MODE = process.env.CONSOLE_RUNTIME === "docker";
const RTVI_VLM_CONTAINER = "rtvi-vlm";
const DOCKER_PROMPT_ENV = "VLM_SYSTEM_PROMPT";
const DOCKER_MODEL_ENV = "VIA_VLM_OPENAI_MODEL_DEPLOYMENT_NAME";
const VSS_INSTANCE_NAME = process.env.VSS_INSTANCE_NAME ?? "";

// Mutex for GCS writes — same pattern as cameras/route.ts.
let _gcsWriteChain: Promise<void> = Promise.resolve();
function chainGcsWrite(fn: () => Promise<void>): Promise<void> {
  _gcsWriteChain = _gcsWriteChain.then(fn).catch((err) => log.error("gcs-write failed", { err }));
  return _gcsWriteChain;
}

/** Read the bundled default VLM system prompt (Pyramid retail loss-prevention
 *  scenario). Returns empty string if the file is missing — callers fall
 *  back to leaving the editor blank. The same text is applied at deploy
 *  time by scripts/stacks/nvidia-vss/bootstrap-compose.sh. */
function readDefaultPrompt(): string {
  try {
    return readFileSync(
      join(process.cwd(), "public/default-vlm-prompt.txt"),
      "utf8",
    )
      .replace(/\r/g, "")
      .trim();
  } catch {
    return "";
  }
}

async function dockerInspectEnv(name: string): Promise<Record<string, string>> {
  const inspect = await inspectContainer(name);
  if (!inspect) throw new Error(`container ${name} not found or docker.sock unavailable`);
  const env: Record<string, string> = {};
  for (const line of inspect.Config.Env ?? []) {
    const eq = line.indexOf("=");
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

// ─── GET ───────────────────────────────────────────────────────────────────────

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const warnings: string[] = [];

  if (DOCKER_MODE) {
    // Fetch GCS state in parallel with the live docker read.
    const gcsPromise = VSS_INSTANCE_NAME
      ? gcsPromptGet(VSS_INSTANCE_NAME)
      : Promise.resolve(null);
    const defaultPrompt = readDefaultPrompt();
    try {
      const [env, gcsCfg] = await Promise.all([
        dockerInspectEnv(RTVI_VLM_CONTAINER),
        gcsPromise,
      ]);
      const livePrompt = env[DOCKER_PROMPT_ENV] ?? "";
      if (gcsCfg && !livePrompt) {
        warnings.push("GCS-persisted prompt not yet applied — restart will pick it up");
      }
      return NextResponse.json({
        prompt: livePrompt,
        model: env[DOCKER_MODEL_ENV] ?? "",
        resourceVersion: undefined,
        runtime: "docker",
        defaultPrompt,
        gcs: buildGcsField(gcsCfg),
        warnings,
      });
    } catch (err) {
      warnings.push(`rtvi-vlm inspect failed: ${String(err)}`);
      const gcsCfg = await gcsPromise.catch(() => null);
      return NextResponse.json(
        { prompt: "", model: "", runtime: "docker", defaultPrompt: readDefaultPrompt(), gcs: buildGcsField(gcsCfg), warnings },
        { status: 502 }
      );
    }
  }

  // k8s path: Firestore is the source of truth for the desired prompt.
  // defaultPrompt is surfaced so the page's "Load default" affordance works
  // when the Firestore doc is empty (e.g. instance not yet seeded post-cutover).
  {
    const { makeReconcileContext } = await import("@/lib/reconcile/context");
    const defaultPrompt = readDefaultPrompt();
    try {
      const ctx = await makeReconcileContext();
      const doc = await ctx.store.readPrompt(ctx.instance);
      return NextResponse.json({ prompt: doc?.prompt ?? "", model: doc?.model ?? "", defaultPrompt, gcs: { available: false }, warnings });
    } catch (err) {
      warnings.push(`config store unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return NextResponse.json({ prompt: "", model: "", defaultPrompt, gcs: { available: false }, warnings });
    }
  }
}

function buildGcsField(gcsCfg: PromptConfig | null) {
  if (!gcsCfg) {
    return { available: false };
  }
  return {
    available: true,
    lastUpdated: gcsCfg.updatedAt,
    lastUpdatedBy: gcsCfg.updatedBy,
    prompt: gcsCfg.prompt,
    model: gcsCfg.model,
  };
}

// ─── PATCH ─────────────────────────────────────────────────────────────────────

const PatchPromptSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
});

export const PATCH = withRequestContext(async (req: NextRequest) => {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;

  const body = await req.json().catch(() => null);
  const parsed = PatchPromptSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", issues: parsed.error.issues }, { status: 400 });
  }

  if (DOCKER_MODE) {
    const { prompt: newPrompt } = parsed.data;
    try {
      const { id } = await dockerRecreateWithEnv(RTVI_VLM_CONTAINER, {
        [DOCKER_PROMPT_ENV]: newPrompt,
      });
      await auditLog("prompt-update", `docker/${RTVI_VLM_CONTAINER}`, {
        promptLength: newPrompt.length,
        newContainerId: id.slice(0, 12),
      });

      // Persist to GCS (best-effort — live update already done).
      const gcsWarnings: string[] = [];
      if (VSS_INSTANCE_NAME) {
        const gcsWarning = await persistPromptToGcs(newPrompt, undefined, session.user?.email ?? "console");
        if (gcsWarning) gcsWarnings.push(gcsWarning);
      }

      return NextResponse.json({
        ok: true,
        runtime: "docker",
        containerId: id.slice(0, 12),
        ...(gcsWarnings.length ? { gcsWarnings } : {}),
      });
    } catch (err) {
      return NextResponse.json(
        {
          error: `rtvi-vlm recreate failed: ${String(err)}`,
          hint: "Old container restored automatically. Check `docker logs rtvi-vlm` on the workspace.",
          runtime: "docker",
        },
        { status: 502 },
      );
    }
  }

  {
    const { makeReconcileContext, ReconcileContextError } = await import("@/lib/reconcile/context");
    const { reconcilePrompt } = await import("@/lib/reconcile/prompt");
    const { prompt, model } = parsed.data;
    try {
      const ctx = await makeReconcileContext();
      await ctx.store.writePrompt(ctx.instance, { prompt, ...(model ? { model } : {}) }, session.user?.email ?? "console");
      const res = await reconcilePrompt({ prompt, ...(model ? { model } : {}) }, ctx.adapter, ctx.refs.prompt);
      await auditLog("prompt-update", `firestore/${ctx.instance}`, { promptLength: prompt.length, modelChanged: !!model });
      return NextResponse.json({ ok: true, ...(res.error ? { warnings: [res.error] } : {}) });
    } catch (err) {
      const msg = err instanceof ReconcileContextError ? err.message : String(err);
      return NextResponse.json({ error: `config store write failed: ${msg}` }, { status: 502 });
    }
  }
});

// ─── GCS write helper ─────────────────────────────────────────────────────────

async function persistPromptToGcs(
  prompt: string,
  model: string | undefined,
  updatedBy: string,
): Promise<string | undefined> {
  let warning: string | undefined;
  await chainGcsWrite(async () => {
    try {
      const config: PromptConfig = {
        schema: "isv-labs.prompt.v1",
        instance: VSS_INSTANCE_NAME,
        updatedAt: new Date().toISOString(),
        updatedBy,
        prompt,
        ...(model ? { model } : {}),
      };
      await gcsPromptPut(config);
    } catch (err) {
      warning = `GCS prompt write failed (live update already applied): ${
        err instanceof Error ? err.message : String(err)
      }`;
      log.warn("gcs prompt write failed", { err });
    }
  });
  return warning;
}
