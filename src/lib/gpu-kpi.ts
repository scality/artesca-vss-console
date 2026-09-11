import type { GpuState } from "@/lib/types";

export interface GpuKpiHeadline {
  /** Busiest card's util%, rounded. Null when no GPUs reported. */
  value: number | null;
  /** The busiest card, named by index — e.g. "GPU 0". Null when no GPUs. */
  label: string | null;
  /** Every card's util%, ascending by index — e.g. "GPU 0 · 47% · GPU 1 · 0%". */
  perCard: string;
}

/** GPU Util KPI headline: the busiest card's 2-min rolling average, named by
 *  index — never an average across cards. Averaging masks a saturated card
 *  behind an idle one by design (a second GPU sitting idle on purpose): the
 *  showroom's VLM card running at 47% and its idle sibling at 0% averaged to
 *  23%, reading as comfortable headroom while the working card was the one
 *  that mattered. Ties break on the lower index so the value is stable. */
export function busiestGpuHeadline(gpus: GpuState[]): GpuKpiHeadline {
  if (gpus.length === 0) {
    return { value: null, label: null, perCard: "" };
  }
  const sorted = [...gpus].sort((a, b) => a.index - b.index);
  const busiest = sorted.reduce((best, g) => (g.utilGpu > best.utilGpu ? g : best), sorted[0]);
  const perCard = sorted.map((g) => `GPU ${g.index} · ${Math.round(g.utilGpu)}%`).join(" · ");
  return {
    value: Math.round(busiest.utilGpu),
    label: `GPU ${busiest.index}`,
    perCard,
  };
}
