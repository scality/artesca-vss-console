import { KubeConfig, CoreV1Api, AppsV1Api, BatchV1Api } from "@kubernetes/client-node";

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
