import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { promQuery } from "@/lib/helpers/prometheus";
import type { GpuState } from "@/lib/types";

export const dynamic = "force-dynamic";

function parseNvidiaSmiCsv(out: string): GpuState[] {
  const gpus: GpuState[] = [];
  for (const line of out.split("\n")) {
    const cols = line.split(",").map((s) => s.trim());
    if (cols.length < 7 || !cols[0] || isNaN(parseInt(cols[0], 10))) continue;
    const index = parseInt(cols[0], 10);
    const memTotal = parseFloat(cols[2]) || 0;
    const memUsed = parseFloat(cols[3]) || 0;
    gpus.push({
      index,
      name: cols[1] || `GPU ${index}`,
      memoryUsedMiB: memUsed,
      memoryTotalMiB: memTotal || 1,
      utilGpu: parseFloat(cols[4]) || 0,
      utilMem: memTotal > 0 ? (memUsed / memTotal) * 100 : 0,
      tempC: parseFloat(cols[5]) || 0,
      powerW: parseFloat(cols[6]) || 0,
      processes: [],
    });
  }
  return gpus;
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });


  const warnings: string[] = [];

  const [utilRes, fbUsedRes, fbTotalRes, tempRes, powerRes] = await Promise.all([
    promQuery("DCGM_FI_DEV_GPU_UTIL"),
    promQuery("DCGM_FI_DEV_FB_USED"),
    promQuery("DCGM_FI_DEV_FB_TOTAL"),
    promQuery("DCGM_FI_DEV_GPU_TEMP"),
    promQuery("DCGM_FI_DEV_POWER_USAGE"),
  ]);

  for (const r of [utilRes, fbUsedRes, fbTotalRes, tempRes, powerRes]) {
    if (r.warning) warnings.push(r.warning);
  }

  const gpuIndexSet = new Set<string>();
  const nameMap = new Map<string, string>();

  for (const r of [utilRes, fbUsedRes, fbTotalRes, tempRes, powerRes]) {
    for (const item of r.results) {
      const gpuIdx = item.metric["gpu"] ?? item.metric["GPU"] ?? "0";
      gpuIndexSet.add(gpuIdx);
      if (item.metric["modelName"] && !nameMap.has(gpuIdx)) {
        nameMap.set(gpuIdx, item.metric["modelName"]);
      }
    }
  }

  if (gpuIndexSet.size === 0) {
    return NextResponse.json({ gpus: [], warnings });
  }

  const gpus: GpuState[] = [];

  for (const gpuIdx of gpuIndexSet) {
    const getVal = (res: typeof utilRes) => {
      const found = res.results.find(
        (r) => (r.metric["gpu"] ?? r.metric["GPU"]) === gpuIdx
      );
      return found ? parseFloat(found.value[1]) : 0;
    };

    const fbUsed = getVal(fbUsedRes);
    const fbTotal = getVal(fbTotalRes);

    gpus.push({
      index: parseInt(gpuIdx, 10),
      name: nameMap.get(gpuIdx) ?? `GPU ${gpuIdx}`,
      memoryUsedMiB: fbUsed,
      memoryTotalMiB: fbTotal || 1,
      utilGpu: getVal(utilRes),
      utilMem: fbTotal > 0 ? (fbUsed / fbTotal) * 100 : 0,
      tempC: getVal(tempRes),
      powerW: getVal(powerRes),
      processes: [],
    });
  }

  gpus.sort((a, b) => a.index - b.index);

  return NextResponse.json({ gpus, warnings });
}
