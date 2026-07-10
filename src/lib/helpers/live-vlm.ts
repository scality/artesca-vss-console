import "server-only";

/**
 * live-vlm.ts — read the VLM that is *actually deployed*, rather than trusting a
 * static catalog or a stale persisted model name.
 *
 * The `vss-rtvi-vlm` Deployment runs the `vss-rt-vlm` **serving runtime**; the
 * actual model it loads is set by the container env (`MODEL_PATH` /
 * `VLM_MODEL_TO_USE`) — e.g. cosmos-reason2-8b. The `/prompt` page and
 * `/api/models` surface the real model; the reasoning LLM is changed on `/agent`.
 */
import { appsV1 } from "@/lib/k8s";
import { CLUSTER } from "@/lib/cluster-refs";

export interface LiveVlm {
  /** Runtime image ref, e.g. nvcr.io/nvidia/vss-core/vss-rt-vlm:3.2.0 */
  image: string;
  /** Best label — the actual model when known (e.g. "Cosmos Reason 2 8B"), else the runtime. */
  displayName: string;
  /** Raw model id from the deployment env, e.g. "cosmos-reason2-8b" ("" if unknown). */
  modelId: string;
  /** Serving-runtime display, e.g. "VSS RT-VLM 3.2.0". */
  runtime: string;
  /** Runtime image tag, e.g. "3.2.0". */
  tag: string;
}

/** Runtime display derived from a VLM image ref. Pure/isomorphic. */
export function vlmDisplayFromImage(image: string): { image: string; displayName: string; tag: string } {
  const clean = image.trim();
  const tag = clean.includes(":") ? clean.slice(clean.lastIndexOf(":") + 1) : "";
  const repo = (clean.split("/").pop() ?? clean).replace(/:.*$/, "");
  const name =
    repo === "vss-rt-vlm"
      ? "VSS RT-VLM"
      : repo.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return { image: clean, displayName: tag ? `${name} ${tag}` : name, tag };
}

/** Pretty-print a model id: "cosmos-reason2-8b" → "Cosmos Reason 2 8B". Pure. */
export function prettyModelName(id: string): string {
  return id
    .replace(/[-_]/g, " ")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2") // reason2 → reason 2
    .replace(/\b(\d+)\s*b\b/gi, "$1B") // 8b → 8B
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** Extract the model id from the VLM container env: MODEL_PATH
 *  (ngc:nim/nvidia/<id>:tag or a path) or VLM_MODEL_TO_USE. "" if neither. */
export function modelIdFromEnv(env: Record<string, string>): string {
  const path = (env.MODEL_PATH ?? "").trim();
  if (path) {
    const last = path.split("/").pop() ?? path; // e.g. cosmos-reason2-8b:hf-1208
    return last.replace(/:.*$/, "").trim(); // cosmos-reason2-8b
  }
  return (env.VLM_MODEL_TO_USE ?? "").trim();
}

/** Read the live VLM — the actual model + its serving runtime — from the
 *  Deployment. Returns null on any failure so callers degrade gracefully. */
export async function readLiveVlm(): Promise<LiveVlm | null> {
  const name = CLUSTER.rtvi.vlmDeployment;
  const namespace = CLUSTER.rtvi.vlmNamespace;
  if (!name || !namespace) return null;
  try {
    const d = await appsV1().readNamespacedDeployment({ name, namespace });
    const container = d.spec?.template?.spec?.containers?.[0];
    const image = container?.image ?? "";
    if (!image) return null;
    const env: Record<string, string> = {};
    for (const e of container?.env ?? []) {
      if (typeof e.value === "string") env[e.name] = e.value;
    }
    const rt = vlmDisplayFromImage(image);
    const modelId = modelIdFromEnv(env);
    return {
      image,
      tag: rt.tag,
      runtime: rt.displayName,
      modelId,
      displayName: modelId ? prettyModelName(modelId) : rt.displayName,
    };
  } catch {
    return null;
  }
}
