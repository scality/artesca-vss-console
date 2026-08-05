import { KubeConfig, CoreV1Api, AppsV1Api, BatchV1Api, Exec, type V1Pod, type V1EnvVar, setHeaderOptions, PatchStrategy } from "@kubernetes/client-node";
import { Writable } from "node:stream";
import { existsSync } from "node:fs";
import { createLogger } from "@/lib/logger";

const log = createLogger("k8s");

let _kc: KubeConfig | null = null;

// In-cluster service-account token — present only inside a pod.
const IN_CLUSTER_TOKEN = "/var/run/secrets/kubernetes.io/serviceaccount/token";

// The client-node v1 Exec (native `ws`) rejects a failed WebSocket upgrade with
// a plain response-shaped object, not an Error — so `String(err)` downstream
// collapses to "[object Object]" and hides the real cause. Normalize to an Error
// that captures the object's own props (incl. non-enumerable message/statusCode).
function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (typeof err === "string") return new Error(err);
  try {
    const dump = JSON.stringify(err, Object.getOwnPropertyNames(err as object));
    if (dump && dump !== "{}") return new Error(dump);
  } catch {
    /* circular / non-serializable */
  }
  return new Error(String(err));
}

export function getKubeConfig(): KubeConfig {
  if (_kc) return _kc;
  _kc = new KubeConfig();
  // Use the in-cluster service account ONLY when actually running in a pod.
  // @kubernetes/client-node's loadFromCluster() no longer throws off-cluster —
  // it builds an unusable `https://undefined:undefined` server from the absent
  // KUBERNETES_SERVICE_* env, so the old try/catch never fell back to the
  // local kubeconfig (every call then failed with "Invalid URL"). Gate on the
  // SA token file so local / remote-console runs use $KUBECONFIG / ~/.kube/config.
  if (existsSync(IN_CLUSTER_TOKEN)) {
    _kc.loadFromCluster();
  } else {
    _kc.loadFromDefault();
  }
  return _kc;
}

export function coreV1(): CoreV1Api {
  return getKubeConfig().makeApiClient(CoreV1Api);
}

export function appsV1(): AppsV1Api {
  return getKubeConfig().makeApiClient(AppsV1Api);
}

export function batchV1(): BatchV1Api {
  return getKubeConfig().makeApiClient(BatchV1Api);
}

/**
 * Options to set Content-Type: application/strategic-merge-patch+json on every
 * merge-style patch call. The @kubernetes/client-node 1.x generated client
 * defaults to application/json-patch+json (JSON Patch array format), which the
 * apiserver rejects for plain merge-style object bodies with HTTP 400.
 */
export const MERGE_PATCH_OPTS = setHeaderOptions("Content-Type", PatchStrategy.StrategicMergePatch);

/**
 * Options to set Content-Type: application/json-patch+json for RFC 6902 JSON
 * Patch bodies (an ops array). Use this when replacing a list wholesale — a
 * strategic merge patch would merge list entries by key, which can leave stale
 * sibling fields behind (e.g. an env var's old `value` when swapping it to a
 * `valueFrom`).
 */
export const JSON_PATCH_OPTS = setHeaderOptions("Content-Type", PatchStrategy.JsonPatch);

/**
 * Resolve a container env var's effective value from an env list, following a
 * `secretKeyRef` to the K8s Secret when the value isn't a plain literal. Used
 * by the LLM health probe so a secret-backed key (e.g. OPENAI_API_KEY wired to
 * the vss-agent-anthropic secret) is read correctly instead of falling back to
 * an unrelated plaintext key. Fail-soft: returns undefined if absent/unreadable.
 */
export async function resolveEnvValue(
  env: V1EnvVar[],
  name: string,
  namespace: string,
): Promise<string | undefined> {
  const e = env.find((ev) => ev.name === name);
  if (!e) return undefined;
  if (typeof e.value === "string" && e.value !== "") return e.value;
  const ref = e.valueFrom?.secretKeyRef;
  if (ref?.name && ref?.key) {
    try {
      const sec = await coreV1().readNamespacedSecret({ name: ref.name, namespace });
      const b64 = sec.data?.[ref.key];
      if (b64) return Buffer.from(b64, "base64").toString("utf-8");
    } catch {
      // fail-soft — unreadable secret just means the probe runs unauthenticated
    }
  }
  return undefined;
}

export function watchedNamespaces(): string[] {
  const legacy = process.env.CONSOLE_LEGACY_NAMESPACES === "1";
  const vssNs = process.env.VSS_NAMESPACE ?? "vss-base";
  const defaultNs = legacy
    ? "vst,rtvi,agent,alerts,pyramid-ingress"
    : `${vssNs},pyramid-ingress`;
  const raw = process.env.KUBE_NAMESPACES ?? defaultNs;
  return raw.split(",").map((ns) => ns.trim()).filter(Boolean);
}

export interface PodRunResult {
  stdout: string;
  stderr: string;
  /** Exit code, or null if the WebSocket closed before the status callback fired. */
  code: number | null;
}

/**
 * Run a command inside the first Running pod matching `labelSelector` in
 * `namespace`, collecting stdout/stderr into strings.
 *
 * Internally uses the Kubernetes Exec WebSocket API (not child_process).
 * The `command` array is passed directly to the container runtime — no shell
 * expansion occurs, so no injection risk.
 */
export async function runInPod(
  namespace: string,
  labelSelector: string,
  command: string[],
  timeoutMs = 10_000
): Promise<PodRunResult> {
  const kc = getKubeConfig();
  const core = kc.makeApiClient(CoreV1Api);

  const podList = await core.listNamespacedPod({
    namespace,
    labelSelector,
    fieldSelector: "status.phase=Running",
    limit: 1,
  });
  const pod = podList.items[0];
  if (!pod?.metadata?.name) {
    throw new Error(`No running pod found in ${namespace} matching ${labelSelector}`);
  }
  const podName = pod.metadata.name;
  const containerName = pod.spec?.containers?.[0]?.name ?? "";

  const podExec = new Exec(kc);

  return new Promise<PodRunResult>((resolve, reject) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`runInPod timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    const stdoutStream = new Writable({
      write(chunk: Buffer, _enc: string, cb: () => void) {
        stdoutBuf += chunk.toString();
        cb();
      },
    });
    const stderrStream = new Writable({
      write(chunk: Buffer, _enc: string, cb: () => void) {
        stderrBuf += chunk.toString();
        cb();
      },
    });

    podExec
      .exec(
        namespace,
        podName,
        containerName,
        command,
        stdoutStream,
        stderrStream,
        null,
        false,
        (status) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            const code =
              status.status === "Success"
                ? 0
                : typeof status.details?.causes?.[0]?.message === "string"
                ? parseInt(status.details.causes[0].message, 10) || 1
                : 1;
            resolve({ stdout: stdoutBuf, stderr: stderrBuf, code });
          }
        }
      )
      .then((ws) => {
        ws.on("close", () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve({ stdout: stdoutBuf, stderr: stderrBuf, code: null });
          }
        });
        ws.on("error", (err: unknown) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(toError(err));
          }
        });
      })
      .catch((err: unknown) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(toError(err));
        }
      });
  });
}

/**
 * Trigger a rollout restart for a Deployment or StatefulSet by patching
 * the `kubectl.kubernetes.io/restartedAt` annotation — same mechanism as
 * `kubectl rollout restart`.
 */
export async function rolloutRestart(
  kind: "Deployment" | "StatefulSet",
  namespace: string,
  name: string
): Promise<void> {
  const patch = {
    spec: {
      template: {
        metadata: {
          annotations: {
            "kubectl.kubernetes.io/restartedAt": new Date().toISOString(),
          },
        },
      },
    },
  };

  if (kind === "Deployment") {
    await appsV1().patchNamespacedDeployment(
      { name, namespace, body: patch },
      MERGE_PATCH_OPTS,
    );
  } else {
    await appsV1().patchNamespacedStatefulSet(
      { name, namespace, body: patch },
      MERGE_PATCH_OPTS,
    );
  }
}

/**
 * Block until a Deployment has finished rolling: the controller has observed
 * the current generation and every replica is updated and available — i.e. the
 * OLD pods are gone.
 *
 * Needed whenever a restart exists to make a pod re-read changed config and the
 * caller then acts on the assumption that it has. A restart alone does not give
 * that: the outgoing pod keeps running its loop for the seconds the rollout
 * takes, and a controller-style workload will happily undo whatever the caller
 * does in that window from its stale view.
 *
 * Returns false on timeout rather than throwing — the caller usually wants to
 * proceed with a warning, not fail the whole operation.
 */
export async function waitForRollout(
  namespace: string,
  name: string,
  timeoutMs = 90_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const dep = await appsV1().readNamespacedDeployment({ name, namespace });
      const generation = dep.metadata?.generation ?? 0;
      const status = dep.status ?? {};
      const desired = dep.spec?.replicas ?? 1;
      if (
        (status.observedGeneration ?? -1) >= generation &&
        (status.updatedReplicas ?? 0) === desired &&
        (status.availableReplicas ?? 0) === desired &&
        (status.replicas ?? 0) === desired // no surviving old replica
      ) {
        return true;
      }
    } catch {
      // Transient API error — keep waiting; the deadline is the real bound.
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return false;
}

/** Set a Deployment's replica count. */
export async function scaleDeployment(
  namespace: string,
  name: string,
  replicas: number,
): Promise<void> {
  await appsV1().patchNamespacedDeployment(
    { name, namespace, body: { spec: { replicas } } },
    MERGE_PATCH_OPTS,
  );
}

/**
 * Scale a Deployment to zero and wait until none of its pods exist any more.
 * Returns the replica count it had so the caller can put it back.
 *
 * Use this — not a restart — when a controller-style workload must be
 * guaranteed not to act while the caller changes the state it manages. A
 * rolling restart cannot give that guarantee: with maxSurge the outgoing pod
 * overlaps the new one, and it then keeps running its loop for the whole
 * termination grace period (30s here, against a 15s tick), reverting the
 * caller's changes from its stale view after the rollout already reported
 * itself complete.
 *
 * Waits on the pods disappearing rather than on `status.replicas`, because a
 * pod that is terminating is still executing.
 */
export async function quiesceDeployment(
  namespace: string,
  name: string,
  timeoutMs = 90_000,
): Promise<{ previousReplicas: number; quiesced: boolean }> {
  const dep = await appsV1().readNamespacedDeployment({ name, namespace });
  const previousReplicas = dep.spec?.replicas ?? 1;
  const labelSelector = Object.entries(dep.spec?.selector?.matchLabels ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(",");

  await scaleDeployment(namespace, name, 0);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pods = labelSelector
        ? await listAllPodsInNs(coreV1(), namespace, { labelSelector })
        : [];
      if (pods.length === 0) return { previousReplicas, quiesced: true };
    } catch {
      // Transient API error — the deadline is the real bound.
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return { previousReplicas, quiesced: false };
}

const LIST_PODS_PAGE_SIZE = 500;
const LIST_PODS_MAX_PAGES = 10;

/**
 * Paginate listNamespacedPod and return all pods in one array.
 * Caps at LIST_PODS_MAX_PAGES * limit items and logs a warning if hit.
 */
export async function listAllPodsInNs(
  coreApi: CoreV1Api,
  namespace: string,
  opts: { labelSelector?: string; limit?: number } = {}
): Promise<V1Pod[]> {
  const limit = opts.limit ?? LIST_PODS_PAGE_SIZE;
  const all: V1Pod[] = [];
  let _continue: string | undefined;
  let pages = 0;
  do {
    const resp = await coreApi.listNamespacedPod({
      namespace,
      labelSelector: opts.labelSelector,
      limit,
      _continue,
    });
    all.push(...(resp.items ?? []));
    _continue = resp.metadata?._continue || undefined;
    pages += 1;
    if (pages >= LIST_PODS_MAX_PAGES) {
      log.warn(`listAllPodsInNs: more than ${pages * limit} pods in ${namespace}, stopping`);
      break;
    }
  } while (_continue);
  return all;
}
