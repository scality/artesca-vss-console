/**
 * Shared helper for applying a VLM prompt update — used by both the route
 * handler and the GCS bootstrap. Isolates the docker-sock / k8s logic so
 * the bootstrap can call it directly without HTTP round-trips.
 */
import "server-only";
import { dockerSock } from "./docker-sock";
import { patchConfigMapRawKey } from "./configmaps";
import { CLUSTER } from "../cluster-refs";

const RTVI_VLM_CONTAINER = "rtvi-vlm";
const DOCKER_PROMPT_ENV = "VLM_SYSTEM_PROMPT";

// ─── Docker helpers ───────────────────────────────────────────────────────────

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

  try {
    await dockerSock("POST", `/containers/${encodeURIComponent(name)}/stop?t=10`, undefined, 30_000);
  } catch {
    // best-effort
  }
  await dockerSock("POST", `/containers/${encodeURIComponent(name)}/rename?name=${encodeURIComponent(backupName)}`);

  try {
    const created = (await dockerSock(
      "POST",
      `/containers/create?name=${encodeURIComponent(name)}`,
      createBody,
      20_000,
    )) as { Id: string };
    await dockerSock("POST", `/containers/${created.Id}/start`, undefined, 20_000);
    await dockerSock("DELETE", `/containers/${encodeURIComponent(backupName)}?force=1`).catch(() => undefined);
    return { id: created.Id };
  } catch (err) {
    await dockerSock("DELETE", `/containers/${encodeURIComponent(name)}?force=1`).catch(() => undefined);
    await dockerSock(
      "POST",
      `/containers/${encodeURIComponent(backupName)}/rename?name=${encodeURIComponent(name)}`,
    ).catch(() => undefined);
    await dockerSock("POST", `/containers/${encodeURIComponent(name)}/start`).catch(() => undefined);
    throw err;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Read the current VLM prompt from the live runtime (docker or k8s). */
export async function readPromptLive(dockerMode: boolean): Promise<string> {
  if (dockerMode) {
    const env = await dockerInspectEnv(RTVI_VLM_CONTAINER);
    return env[DOCKER_PROMPT_ENV] ?? "";
  }
  const cm = await (await import("../k8s")).coreV1().readNamespacedConfigMap({
    name: CLUSTER.rtvi.runtimeEnvCm,
    namespace: CLUSTER.rtvi.nimNamespace,
  });
  return cm.data?.[CLUSTER.rtvi.promptKey] ?? "";
}

/** Apply a new VLM prompt to the live runtime.  Throws on failure. */
export async function applyPromptLive(
  dockerMode: boolean,
  prompt: string,
): Promise<void> {
  if (dockerMode) {
    await dockerRecreateWithEnv(RTVI_VLM_CONTAINER, { [DOCKER_PROMPT_ENV]: prompt });
    return;
  }
  await patchConfigMapRawKey(
    CLUSTER.rtvi.nimNamespace,
    CLUSTER.rtvi.runtimeEnvCm,
    CLUSTER.rtvi.promptKey,
    prompt,
  );
}
