import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { createLogger } from "@/lib/logger";
import { withRequestContext } from "@/lib/with-request-context";
import { readDefaultPrompt } from "@/lib/helpers/default-prompt";

const log = createLogger("api/prompt");
import { z } from "zod";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { auditLog } from "@/lib/helpers/audit";
import {
  gcsPromptGet,
  gcsPromptPut,
  type PromptConfig,
} from "@/lib/helpers/gcs-config";

export const dynamic = "force-dynamic";

const RTVI_VLM_CONTAINER = "rtvi-vlm";
const DOCKER_PROMPT_ENV = "VLM_SYSTEM_PROMPT";
const VSS_INSTANCE_NAME = process.env.VSS_INSTANCE_NAME ?? "";

// Mutex for GCS writes — same pattern as cameras/route.ts.
let _gcsWriteChain: Promise<void> = Promise.resolve();
function chainGcsWrite(fn: () => Promise<void>): Promise<void> {
  _gcsWriteChain = _gcsWriteChain.then(fn).catch((err) => log.error("gcs-write failed", { err }));
  return _gcsWriteChain;
}

// ─── GET ───────────────────────────────────────────────────────────────────────

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const warnings: string[] = [];


  // k8s path: Firestore is the source of truth for the desired prompt.
  // defaultPrompt is surfaced so the page's "Load default" affordance works
  // when the Firestore doc is empty (e.g. instance not yet seeded post-cutover).
  {
    const { makeReconcileContext } = await import("@/lib/reconcile/context");
    const { readLiveVlm } = await import("@/lib/helpers/live-vlm");
    const defaultPrompt = readDefaultPrompt();
    try {
      const ctx = await makeReconcileContext();
      const [doc, sets, activePromptId, liveVlm] = await Promise.all([
        ctx.store.readPrompt(ctx.instance),
        (ctx.store.readPromptSets ? ctx.store.readPromptSets(ctx.instance) : Promise.resolve([])) as Promise<import("@/lib/config-store/types").PromptSet[]>,
        (ctx.store.readActivePromptId ? ctx.store.readActivePromptId(ctx.instance) : Promise.resolve(null)) as Promise<string | null>,
        readLiveVlm(),
      ]);
      // `model` reflects the VLM actually deployed (read live), not the legacy
      // `doc.model` field — which can hold a stale name from an earlier seed.
      const model = liveVlm?.displayName ?? doc?.model ?? "";
      return NextResponse.json({ prompt: doc?.prompt ?? "", model, runtime: "k8s", sets, activePromptId, defaultPrompt, gcs: { available: false }, previewAvailable: Boolean(process.env.NIM_PREVIEW_ENDPOINT), warnings });
    } catch (err) {
      warnings.push(`config store unavailable: ${err instanceof Error ? err.message : String(err)}`);
      const liveVlm = await readLiveVlm().catch(() => null);
      return NextResponse.json({ prompt: "", model: liveVlm?.displayName ?? "", sets: [], activePromptId: null, defaultPrompt, gcs: { available: false }, warnings });
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

const PromptSetPatch = z.object({
  set: z.object({ id: z.string().min(1), name: z.string().min(1), text: z.string(), model: z.string().optional(), alertType: z.string().optional() }).optional(),
  deleteSetId: z.string().optional(),
  activePromptId: z.string().optional(),
});

export const PATCH = withRequestContext(async (req: NextRequest) => {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;

  const body = await req.json().catch(() => null);


  {
    const { makeReconcileContext, ReconcileContextError } = await import("@/lib/reconcile/context");
    const { reconcilePrompt } = await import("@/lib/reconcile/prompt");
    const warnings: string[] = [];

    // Prompt-set library ops: {set} / {deleteSetId} / {activePromptId}
    const setsParsed = PromptSetPatch.safeParse(body);
    if (setsParsed.success && (setsParsed.data.set !== undefined || setsParsed.data.deleteSetId !== undefined || setsParsed.data.activePromptId !== undefined)) {
      const { set, deleteSetId, activePromptId } = setsParsed.data;
      try {
        const ctx = await makeReconcileContext();
        const actor = session.user?.email ?? "console";
        if (set !== undefined) {
          await ctx.store.upsertPromptSet(ctx.instance, set, actor);
          await auditLog("prompt-set-upsert", `firestore/${ctx.instance}`, { setId: set.id });
        }
        if (deleteSetId !== undefined) {
          const currentActiveId = ctx.store.readActivePromptId
            ? await ctx.store.readActivePromptId(ctx.instance)
            : null;
          if (currentActiveId === deleteSetId) {
            return NextResponse.json(
              { error: "Cannot delete the active prompt set. Activate another set first." },
              { status: 409 },
            );
          }
          await ctx.store.deletePromptSet(ctx.instance, deleteSetId, actor);
          await auditLog("prompt-set-delete", `firestore/${ctx.instance}`, { setId: deleteSetId });
        }
        if (activePromptId !== undefined) {
          await ctx.store.setActivePromptId(ctx.instance, activePromptId, actor);
          const desired = await ctx.store.readPrompt(ctx.instance);
          const res = await reconcilePrompt(desired, ctx.adapter, ctx.refs.prompt);
          if (res.error) warnings.push(res.error);
          await auditLog("prompt-active-set", `firestore/${ctx.instance}`, { activePromptId });
        }
        return NextResponse.json({ ok: true, ...(warnings.length ? { warnings } : {}) });
      } catch (err) {
        const msg = err instanceof ReconcileContextError ? err.message : String(err);
        return NextResponse.json({ error: `config store write failed: ${msg}` }, { status: 502 });
      }
    }

    // Single-prompt edit: {prompt, model?}
    const parsed = PatchPromptSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Validation failed", issues: parsed.error.issues }, { status: 400 });
    }
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
