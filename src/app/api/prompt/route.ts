import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { coreV1, rolloutRestart } from "@/lib/k8s";
import { patchConfigMapRawKey } from "@/lib/helpers/configmaps";
import { auditLog } from "@/lib/helpers/audit";
import { CLUSTER } from "@/lib/cluster-refs";
import {
  gcsPromptGet,
  gcsPromptPut,
  type PromptConfig,
} from "@/lib/helpers/gcs-config";

export const dynamic = "force-dynamic";

const DOCKER_MODE = process.env.CONSOLE_RUNTIME === "docker";
const RTVI_VLM_CONTAINER = "rtvi-vlm";
const DOCKER_PROMPT_ENV = "VLM_SYSTEM_PROMPT";
const DOCKER_MODEL_ENV = "VIA_VLM_OPENAI_MODEL_DEPLOYMENT_NAME";
const VSS_INSTANCE_NAME = process.env.VSS_INSTANCE_NAME ?? "";

// Mutex for GCS writes — same pattern as cameras/route.ts.
let _gcsWriteChain: Promise<void> = Promise.resolve();
function chainGcsWrite(fn: () => Promise<void>): Promise<void> {
  _gcsWriteChain = _gcsWriteChain.then(fn).catch(() => void 0);
  return _gcsWriteChain;
}

/** Read the bundled default VLM system prompt (Pyramid retail loss-prevention
 *  scenario). Returns empty string if the file is missing — callers fall
 *  back to leaving the editor blank. The same text is applied at deploy
 *  time by scripts/stacks/vss/bootstrap-compose.sh. */
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

/** Generic docker.sock request helper. Returns parsed JSON (or empty object
 *  for 204/empty bodies). Throws on >=400 with the response body in the
 *  error message. Bounded timeout — callers shouldn't block the dashboard
 *  on a hung daemon. */
async function dockerSock(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  timeoutMs = 8_000,
): Promise<Record<string, unknown>> {
  const http = await import("node:http");
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath: "/var/run/docker.sock",
        path,
        method,
        timeout: timeoutMs,
        headers: payload
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload).toString() }
          : undefined,
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(
              new Error(`docker.sock ${method} ${path}: ${res.statusCode} ${buf.slice(0, 300)}`),
            );
            return;
          }
          if (!buf.trim()) {
            resolve({});
            return;
          }
          try {
            resolve(JSON.parse(buf));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`docker.sock timeout (${path})`)));
    if (payload) req.write(payload);
    req.end();
  });
}

async function dockerInspectEnv(name: string): Promise<Record<string, string>> {
  const json = (await dockerSock("GET", `/containers/${encodeURIComponent(name)}/json`)) as {
    Config?: { Env?: string[] };
  };
  const env: Record<string, string> = {};
  for (const line of json.Config?.Env ?? []) {
    const eq = line.indexOf("=");
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

/** Recreate the named container with patched env vars, preserving image,
 *  entrypoint, mounts, network mode, GPU device requests, restart policy,
 *  exposed ports, and compose labels (so docker-compose still recognises
 *  the container as managed by the same project).
 *
 *  Strategy: stop → rename old to <name>-bak-<ts> → create new from patched
 *  config → start new. If start fails, the new container is removed and the
 *  old one is renamed back + started, so the operator never ends up with
 *  the service permanently down. */
async function dockerRecreateWithEnv(
  name: string,
  envPatch: Record<string, string>,
): Promise<{ id: string }> {
  const inspect = (await dockerSock("GET", `/containers/${encodeURIComponent(name)}/json`)) as {
    Config: {
      Image: string;
      Env: string[];
      Cmd: string[] | null;
      Entrypoint: string[] | null;
      ExposedPorts?: Record<string, unknown>;
      Labels?: Record<string, string>;
      WorkingDir?: string;
      User?: string;
    };
    HostConfig: Record<string, unknown>;
    NetworkSettings: { Networks: Record<string, unknown> };
  };

  // Build new env list: replace patched keys, preserve the rest in order.
  const seen = new Set<string>();
  const newEnv: string[] = [];
  for (const line of inspect.Config.Env ?? []) {
    const eq = line.indexOf("=");
    const k = eq > 0 ? line.slice(0, eq) : line;
    if (k in envPatch) {
      newEnv.push(`${k}=${envPatch[k]}`);
      seen.add(k);
    } else {
      newEnv.push(line);
    }
  }
  for (const [k, v] of Object.entries(envPatch)) {
    if (!seen.has(k)) newEnv.push(`${k}=${v}`);
  }

  // Single-network case — preserve the network connection. Multi-network
  // recreate would need POST /networks/<id>/connect after start; not
  // supported here because rtvi-vlm and friends are single-network.
  const networks = Object.keys(inspect.NetworkSettings?.Networks ?? {});
  const networkingConfig =
    networks.length > 0
      ? { EndpointsConfig: Object.fromEntries(networks.map((n) => [n, {}])) }
      : undefined;

  const createBody: Record<string, unknown> = {
    Image: inspect.Config.Image,
    Env: newEnv,
    Cmd: inspect.Config.Cmd,
    Entrypoint: inspect.Config.Entrypoint,
    ExposedPorts: inspect.Config.ExposedPorts,
    Labels: inspect.Config.Labels,
    WorkingDir: inspect.Config.WorkingDir,
    User: inspect.Config.User,
    HostConfig: inspect.HostConfig,
    ...(networkingConfig ? { NetworkingConfig: networkingConfig } : {}),
  };

  const ts = Date.now();
  const backupName = `${name}-bak-${ts}`;

  // Stop + rename old
  try {
    await dockerSock("POST", `/containers/${encodeURIComponent(name)}/stop?t=10`, undefined, 30_000);
  } catch {
    // best-effort — container may already be stopped
  }
  await dockerSock("POST", `/containers/${encodeURIComponent(name)}/rename?name=${encodeURIComponent(backupName)}`);

  // Create + start new
  try {
    const created = (await dockerSock(
      "POST",
      `/containers/create?name=${encodeURIComponent(name)}`,
      createBody,
      20_000,
    )) as { Id: string };
    await dockerSock("POST", `/containers/${created.Id}/start`, undefined, 20_000);

    // Success — remove backup
    await dockerSock("DELETE", `/containers/${encodeURIComponent(backupName)}?force=1`).catch(
      () => undefined, // best-effort cleanup
    );
    return { id: created.Id };
  } catch (err) {
    // Rollback: clean up partial new container, restore old by name+start.
    await dockerSock("DELETE", `/containers/${encodeURIComponent(name)}?force=1`).catch(() => undefined);
    await dockerSock(
      "POST",
      `/containers/${encodeURIComponent(backupName)}/rename?name=${encodeURIComponent(name)}`,
    ).catch(() => undefined);
    await dockerSock("POST", `/containers/${encodeURIComponent(name)}/start`).catch(() => undefined);
    throw err;
  }
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

export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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

  try {
    // Read current resourceVersion if not provided via If-Match
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

    // If model is changing, also patch the model key
    if (model) {
      await patchConfigMapRawKey(CLUSTER.rtvi.nimNamespace, CLUSTER.rtvi.runtimeEnvCm, CLUSTER.rtvi.modelKey, model);
    }
  } catch (err: unknown) {
    const k8sErr = err as { statusCode?: number; body?: { message?: string } };
    if (k8sErr.statusCode === 409) {
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

  // Rollout-restart rtvi-vlm (and NIM StatefulSet if model changed)
  const restartErrors: string[] = [];
  try {
    await rolloutRestart("Deployment", CLUSTER.rtvi.nimNamespace, CLUSTER.rtvi.vlmDeployment);
  } catch (err) {
    restartErrors.push(`${CLUSTER.rtvi.vlmDeployment} restart failed: ${String(err)}`);
  }

  if (model) {
    try {
      // cosmos-reason2-8b is a StatefulSet (k8s/vss/rtvi/30-nim-cosmos-reason2-8b.yaml)
      await rolloutRestart("StatefulSet", CLUSTER.rtvi.nimNamespace, CLUSTER.rtvi.nimStatefulSet);
    } catch {
      // Best-effort — NIM restart may be disallowed by RBAC or timing
    }
  }

  await auditLog("prompt-update", `configmap/${CLUSTER.rtvi.runtimeEnvCm}`, {
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
}

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
      console.warn(`[prompt/route] ${warning}`);
    }
  });
  return warning;
}
