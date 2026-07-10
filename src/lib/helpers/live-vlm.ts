import "server-only";

/**
 * live-vlm.ts — read the VLM that is *actually deployed*, rather than trusting a
 * static catalog or a stale persisted model name. On the Helm profiles the VLM
 * is the chart-fixed `vss-rtvi-vlm` Deployment (a VILA VLM served by VSS-core);
 * it is not swapped from the console. The `/prompt` page and `/api/models` show
 * this truthfully; the reasoning LLM is changed on `/agent`.
 */
import { appsV1 } from "@/lib/k8s";
import { CLUSTER } from "@/lib/cluster-refs";

export interface LiveVlm {
  /** Full image ref, e.g. nvcr.io/nvidia/vss-core/vss-rt-vlm:3.2.0 */
  image: string;
  /** Human label, e.g. "VSS RT-VLM 3.2.0" */
  displayName: string;
  /** Image tag, e.g. "3.2.0" */
  tag: string;
}

/** Derive a human display name from a VLM image ref. Pure/isomorphic. */
export function vlmDisplayFromImage(image: string): LiveVlm {
  const clean = image.trim();
  const tag = clean.includes(":") ? clean.slice(clean.lastIndexOf(":") + 1) : "";
  const repo = (clean.split("/").pop() ?? clean).replace(/:.*$/, "");
  const name =
    repo === "vss-rt-vlm"
      ? "VSS RT-VLM"
      : repo.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return { image: clean, displayName: tag ? `${name} ${tag}` : name, tag };
}

/** Read the live VLM Deployment image (k8s). Returns null on any failure or
 *  when the deployment/image can't be resolved — callers degrade gracefully. */
export async function readLiveVlm(): Promise<LiveVlm | null> {
  const name = CLUSTER.rtvi.vlmDeployment;
  const namespace = CLUSTER.rtvi.vlmNamespace;
  if (!name || !namespace) return null;
  try {
    const d = await appsV1().readNamespacedDeployment({ name, namespace });
    const image = d.spec?.template?.spec?.containers?.[0]?.image ?? "";
    return image ? vlmDisplayFromImage(image) : null;
  } catch {
    return null;
  }
}
