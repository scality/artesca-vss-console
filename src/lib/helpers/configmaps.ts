import "server-only";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { coreV1 } from "../k8s";

/**
 * Read a ConfigMap, parse the named key as YAML, and return both the raw string
 * and the parsed value together with the current resourceVersion (for
 * optimistic-concurrency patches).
 */
export async function readConfigMapKey<T = unknown>(
  namespace: string,
  name: string,
  key: string
): Promise<{
  value: T;
  raw: string;
  resourceVersion: string | undefined;
}> {
  const cm = await coreV1().readNamespacedConfigMap({ name, namespace });
  const raw = cm.data?.[key] ?? "";
  const value = yamlParse(raw) as T;
  return { value, raw, resourceVersion: cm.metadata?.resourceVersion };
}

/**
 * Patch a single key in a ConfigMap, serialising the new value as YAML.
 * If `resourceVersion` is supplied it is used for optimistic concurrency —
 * the K8s API will return 409 if the ConfigMap was modified since we read it.
 */
export async function patchConfigMapKey(
  namespace: string,
  name: string,
  key: string,
  value: unknown,
  resourceVersion?: string
): Promise<void> {
  const newYaml = yamlStringify(value);
  const patch: Record<string, unknown> = {
    data: { [key]: newYaml },
  };

  if (resourceVersion) {
    patch.metadata = { resourceVersion };
  }

  await coreV1().patchNamespacedConfigMap({
    name,
    namespace,
    body: patch,
  });
}

/**
 * Patch a single raw string key in a ConfigMap (no YAML serialisation).
 */
export async function patchConfigMapRawKey(
  namespace: string,
  name: string,
  key: string,
  value: string,
  resourceVersion?: string
): Promise<void> {
  const patch: Record<string, unknown> = {
    data: { [key]: value },
  };

  if (resourceVersion) {
    patch.metadata = { resourceVersion };
  }

  await coreV1().patchNamespacedConfigMap({
    name,
    namespace,
    body: patch,
  });
}

/**
 * Fully replace a ConfigMap's data map with a new record.
 */
export async function replaceConfigMapData(
  namespace: string,
  name: string,
  data: Record<string, string>,
  resourceVersion?: string
): Promise<void> {
  const patch: Record<string, unknown> = { data };

  if (resourceVersion) {
    patch.metadata = { resourceVersion };
  }

  await coreV1().patchNamespacedConfigMap({
    name,
    namespace,
    body: patch,
  });
}
