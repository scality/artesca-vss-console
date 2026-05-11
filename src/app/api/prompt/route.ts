import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { createLogger } from "@/lib/logger";
import { withRequestContext } from "@/lib/with-request-context";

const log = createLogger("api/prompt");
import { z } from "zod";
import { coreV1, appsV1, rolloutRestart } from "@/lib/k8s";
import { extractK8sError } from "@/lib/errors";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { patchConfigMapRawKey } from "@/lib/helpers/configmaps";
import { auditLog } from "@/lib/helpers/audit";
import { CLUSTER } from "@/lib/cluster-refs";
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

  // Fetch GCS state in parallel with the live read.
  const gcsPromise = VSS_INSTANCE_NAME
    ? gcsPromptGet(VSS_INSTANCE_NAME)
    : Promise.resolve(null);

  if (DOCKER_MODE) {
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

  // Helm path: VLM_SYSTEM_PROMPT is a direct env var on the vss-rtvi-vlm Deployment.
  // Legacy path: prompt lives in ConfigMap rtvi-runtime-env under key RTVI_VLM_SYSTEM_PROMPT.
  if (!CLUSTER.rtvi.runtimeEnvCm) {
    // Helm path — read from Deployment env
    try {
      const [deploy, gcsCfg] = await Promise.all([
        appsV1().readNamespacedDeployment({
          name: CLUSTER.rtvi.vlmDeployment,
          namespace: CLUSTER.rtvi.nimNamespace,
        }),
        gcsPromise,
      ]);
      const envVars = deploy.spec?.template?.spec?.containers?.[0]?.env ?? [];
      const promptEnv = envVars.find((e) => e.name === CLUSTER.rtvi.promptKey);
      const modelEnv = envVars.find((e) => e.name === CLUSTER.rtvi.modelKey);
      const prompt = promptEnv?.value ?? "";
      const model = modelEnv?.value ?? "";
      if (gcsCfg && !prompt) {
        warnings.push("GCS-persisted prompt not yet applied — restart will pick it up");
      }
      return NextResponse.json({ prompt, model, resourceVersion: undefined, gcs: buildGcsField(gcsCfg), warnings });
    } catch (err) {
      warnings.push(`${CLUSTER.rtvi.vlmDeployment} unreadable: ${String(err)}`);
      const gcsCfg = await gcsPromise.catch(() => null);
      return NextResponse.json({ prompt: "", model: "", gcs: buildGcsField(gcsCfg), warnings }, { status: 502 });
    }
  }

  try {
    const [cm, gcsCfg] = await Promise.all([
      coreV1().readNamespacedConfigMap({
        name: CLUSTER.rtvi.runtimeEnvCm,
        namespace: CLUSTER.rtvi.nimNamespace,
      }),
      gcsPromise,
    ]);

    const prompt = cm.data?.[CLUSTER.rtvi.promptKey] ?? "";
    const model = cm.data?.[CLUSTER.rtvi.modelKey] ?? "";
    const resourceVersion = cm.metadata?.resourceVersion;

    if (gcsCfg && !prompt) {
      warnings.push("GCS-persisted prompt not yet applied — restart will pick it up");
    }

    return NextResponse.json({ prompt, model, resourceVersion, gcs: buildGcsField(gcsCfg), warnings });
  } catch (err) {
    warnings.push(`rtvi-runtime-env unreadable: ${String(err)}`);
    const gcsCfg = await gcsPromise.catch(() => null);
    return NextResponse.json({ prompt: "", model: "", gcs: buildGcsField(gcsCfg), warnings }, { status: 502 });
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

  const { prompt, model } = parsed.data;
  const ifMatch = req.headers.get("If-Match") ?? undefined;

  if (!CLUSTER.rtvi.runtimeEnvCm) {
    // Helm path — patch env vars directly on the Deployment
    try {
      const deploy = await appsV1().readNamespacedDeployment({
        name: CLUSTER.rtvi.vlmDeployment,
        namespace: CLUSTER.rtvi.nimNamespace,
      });
      const containers = deploy.spec?.template?.spec?.containers ?? [];
      const container = containers[0];
      if (!container) throw new Error(`No containers in ${CLUSTER.rtvi.vlmDeployment}`);
      const envPatch = container.env ? [...container.env] : [];
      const setEnv = (key: string, value: string) => {
        const idx = envPatch.findIndex((e) => e.name === key);
        if (idx >= 0) envPatch[idx] = { name: key, value };
        else envPatch.push({ name: key, value });
      };
      setEnv(CLUSTER.rtvi.promptKey, prompt);
      if (model) setEnv(CLUSTER.rtvi.modelKey, model);
      await appsV1().patchNamespacedDeployment({
        name: CLUSTER.rtvi.vlmDeployment,
        namespace: CLUSTER.rtvi.nimNamespace,
        body: { spec: { template: { spec: { containers: [{ name: container.name, env: envPatch }] } } } },
      });
    } catch (err: unknown) {
      const { status } = extractK8sError(err);
      return NextResponse.json(
        { error: `Deployment env patch failed: ${String(err)}` },
        { status }
      );
    }
  } else {
    // Legacy path — patch ConfigMap
    try {
      let resourceVersion = ifMatch;
      if (!resourceVersion) {
        const cm = await coreV1().readNamespacedConfigMap({
          name: CLUSTER.rtvi.runtimeEnvCm,
          namespace: CLUSTER.rtvi.nimNamespace,
        });
        resourceVersion = cm.metadata?.resourceVersion;
      }
      await patchConfigMapRawKey(
        CLUSTER.rtvi.nimNamespace,
        CLUSTER.rtvi.runtimeEnvCm,
        CLUSTER.rtvi.promptKey,
        prompt,
        resourceVersion
      );
      if (model) {
        await patchConfigMapRawKey(CLUSTER.rtvi.nimNamespace, CLUSTER.rtvi.runtimeEnvCm, CLUSTER.rtvi.modelKey, model);
      }
    } catch (err: unknown) {
      const { status } = extractK8sError(err);
      if (status === 409) {
        return NextResponse.json(
          { error: "Config modified by another operator — reload and retry" },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { error: `ConfigMap patch failed: ${String(err)}` },
        { status: 502 }
      );
    }
  }

  // Rollout-restart VLM deployment (and NIM if model changed)
  const restartErrors: string[] = [];
  try {
    await rolloutRestart("Deployment", CLUSTER.rtvi.nimNamespace, CLUSTER.rtvi.vlmDeployment);
  } catch (err) {
    restartErrors.push(`${CLUSTER.rtvi.vlmDeployment} restart failed: ${String(err)}`);
  }

  if (model) {
    const nimKind = CLUSTER.legacy ? ("StatefulSet" as const) : ("Deployment" as const);
    try {
      await rolloutRestart(nimKind, CLUSTER.rtvi.nimNamespace, CLUSTER.rtvi.nimStatefulSet);
    } catch {
      // Best-effort — NIM restart may be disallowed by RBAC or timing
    }
  }

  const auditTarget = CLUSTER.rtvi.runtimeEnvCm
    ? `configmap/${CLUSTER.rtvi.runtimeEnvCm}`
    : `deployment/${CLUSTER.rtvi.vlmDeployment}`;
  await auditLog("prompt-update", auditTarget, {
    promptLength: prompt.length,
    modelChanged: !!model,
    newModel: model,
  });

  // Persist to GCS (best-effort — live update already done).
  const gcsWarnings: string[] = [];
  if (VSS_INSTANCE_NAME) {
    const gcsWarning = await persistPromptToGcs(prompt, model, session.user?.email ?? "console");
    if (gcsWarning) gcsWarnings.push(gcsWarning);
  }

  return NextResponse.json({
    ok: true,
    restartErrors: restartErrors.length ? restartErrors : undefined,
    ...(gcsWarnings.length ? { gcsWarnings } : {}),
  });
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
