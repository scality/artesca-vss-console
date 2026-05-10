import { KubeConfig, CoreV1Api, AppsV1Api, BatchV1Api, Exec, type V1Pod } from "@kubernetes/client-node";
import { Writable } from "node:stream";
import { createLogger } from "@/lib/logger";

const log = createLogger("k8s");

let _kc: KubeConfig | null = null;

function getKubeConfig(): KubeConfig {
  if (_kc) return _kc;
  _kc = new KubeConfig();
  try {
    _kc.loadFromCluster();
  } catch {
    // Fall back to local kubeconfig for dev
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

export function watchedNamespaces(): string[] {
  const raw = process.env.KUBE_NAMESPACES ?? "vst,rtvi,agent,alerts,demo-data,pyramid-ingress";
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
        ws.on("error", (err: Error) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        });
      })
      .catch((err: unknown) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
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
    );
  } else {
    await appsV1().patchNamespacedStatefulSet(
      { name, namespace, body: patch },
    );
  }
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
