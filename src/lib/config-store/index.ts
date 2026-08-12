import "server-only";

import type { ConfigStore } from "@/lib/config-store/types";

export type StoreKind = "file" | "firestore";

export class ConfigStoreSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigStoreSelectionError";
  }
}

export const STORE_KINDS: readonly StoreKind[] = ["file", "firestore"];

/** Just the two variables the decision reads. Deliberately not NodeJS.ProcessEnv:
 *  this repo augments that type with required keys, so a test could not pass a
 *  two-key literal and would have to construct a whole environment to assert on
 *  one rule. */
export type StoreEnv = Record<string, string | undefined>;

/**
 * Which backend this process uses, and why.
 *
 * `CONSOLE_CONFIG_STORE` is explicit and always wins. It is the whole of the
 * decision for anything deployed from now on.
 *
 * With it unset the answer is `file` — **except** when `FIRESTORE_PROJECT_ID` is
 * set, which is inferred as `firestore`. That exception is not a convenience; it
 * is what stops this change losing a live lab's configuration. Every existing
 * instance was deployed by `isv-labs:scripts/deploy-console.sh`, which writes
 * `FIRESTORE_PROJECT_ID` into `console-env`, and the ordinary way to ship a new
 * console build to one of those is `kubectl set image` — which does not touch the
 * ConfigMap. Defaulting flatly to `file` would have that pod come up reading an
 * empty YAML file: no cameras, no prompt-sets, no scenarios, no error, and a
 * reconciler that converges the cluster onto nothing.
 *
 * The inference reads `FIRESTORE_PROJECT_ID` only, never `GOOGLE_CLOUD_PROJECT`.
 * The second is ambient on GCP infrastructure and says nothing about what anyone
 * chose; `firestoreProjectId()` accepts it as a *project id* once the backend is
 * already selected, which is a different question.
 */
export function configStoreKind(env: StoreEnv = process.env): StoreKind {
  const explicit = env.CONSOLE_CONFIG_STORE?.trim().toLowerCase();
  if (explicit) {
    if (!STORE_KINDS.includes(explicit as StoreKind)) {
      throw new ConfigStoreSelectionError(
        `CONSOLE_CONFIG_STORE=${JSON.stringify(explicit)} is not a known backend ` +
          `(expected one of: ${STORE_KINDS.join(", ")})`,
      );
    }
    return explicit as StoreKind;
  }
  return env.FIRESTORE_PROJECT_ID?.trim() ? "firestore" : "file";
}

/** True when the selection came from an inference rather than from a setting —
 *  worth saying out loud on `/about` and in the boot log, since the operator did
 *  not choose it. */
export function storeKindWasInferred(env: StoreEnv = process.env): boolean {
  return !env.CONSOLE_CONFIG_STORE?.trim();
}

/**
 * Build the configured store. Throws rather than falling back: a store that is
 * not the one the deployment asked for is worse than no store, because writes
 * land somewhere nobody will look for them.
 */
export async function makeConfigStore(): Promise<ConfigStore> {
  const kind = configStoreKind();
  if (kind === "firestore") {
    const { makeFirestoreConfigStore } = await import("@/lib/config-store/firestore");
    return makeFirestoreConfigStore();
  }
  const { FileConfigStore } = await import("@/lib/config-store/file");
  return new FileConfigStore();
}

export interface ConfigStoreHealth {
  kind: StoreKind;
  inferred: boolean;
  status: "ok" | "unconfigured" | "no-credentials" | "error";
  detail?: string;
  /** Where the data is — a file path, or a GCP project/database pair. */
  location: string;
  counts?: { promptSets: number; cameras: number; scenarios: number };
}

/** One health shape for both backends, so `/about` reports the store the same way
 *  whichever one is selected. Never throws. */
export async function configStoreHealthCheck(instance: string): Promise<ConfigStoreHealth> {
  let kind: StoreKind;
  try {
    kind = configStoreKind();
  } catch (err) {
    return {
      kind: "file",
      inferred: storeKindWasInferred(),
      status: "error",
      detail: err instanceof Error ? err.message : String(err),
      location: "",
    };
  }
  const inferred = storeKindWasInferred();

  if (kind === "firestore") {
    const { firestoreHealthCheck } = await import("@/lib/config-store/firestore");
    const r = await firestoreHealthCheck(instance);
    return {
      kind,
      inferred,
      status: r.status,
      ...(r.detail ? { detail: r.detail } : {}),
      location: `${r.project || "(no project)"}/${r.database}`,
      ...(r.counts ? { counts: r.counts } : {}),
    };
  }

  const { fileStoreHealthCheck } = await import("@/lib/config-store/file");
  const r = await fileStoreHealthCheck(instance);
  return {
    kind,
    inferred,
    status: r.status,
    ...(r.detail ? { detail: r.detail } : {}),
    location: r.file ?? r.dir,
    ...(r.counts ? { counts: r.counts } : {}),
  };
}
