import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseGauge } from "@/lib/helpers/artesca-capacity";

/**
 * The distinction these tests exist to protect:
 *
 *   writeProtectionEnabled = 1  means the guard is ARMED.
 *   Writes are refused only when ARMED **and** fill >= critical.
 *
 * ARTESCA 4.3 auto-enables the guard at install, so a perfectly healthy cluster
 * reports 1 forever. Treating that flag alone as an alarm would fire on every
 * 4.3 cluster; treating fill alone would miss a cluster whose guard is disarmed.
 * pyramid-showroom sat armed at 95.01% refusing every upload, then armed at
 * 83.54% serving them normally — same flag, opposite meaning.
 */

const METRICS = `# HELP hdcontroller_write_protection_enabled Write protection feature status
# TYPE hdcontroller_write_protection_enabled gauge
hdcontroller_filling_critical_alert 0
hdcontroller_filling_early_alert 80
hdcontroller_most_available_storage_group_fill_percent 83.5401152611114
hdcontroller_server_fill_percent{hd="http://artesca-storage-service-ds-41792c2b:4231"} 83.5401152611114
hdcontroller_storage_limit_percent{level="critical"} 95
hdcontroller_storage_limit_percent{level="early"} 80
hdcontroller_write_protection_enabled 1
`;

function metricsWithFill(fill: number, armed = 1) {
  return METRICS.replace("83.5401152611114\nhdcontroller_server", `${fill}\nhdcontroller_server`).replace(
    "hdcontroller_write_protection_enabled 1",
    `hdcontroller_write_protection_enabled ${armed}`,
  );
}

async function read(body: string | null, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (body === null) throw new Error("ECONNREFUSED");
      return { ok, text: async () => body } as unknown as Response;
    }),
  );
  vi.resetModules();
  const mod = await import("@/lib/helpers/artesca-capacity");
  return mod.readArtescaCapacity();
}

describe("parseGauge", () => {
  it("reads an unlabelled gauge", () => {
    expect(parseGauge(METRICS, "hdcontroller_most_available_storage_group_fill_percent")).toBeCloseTo(83.54, 2);
  });

  it("reads a labelled gauge by its exact label selector", () => {
    expect(parseGauge(METRICS, 'hdcontroller_storage_limit_percent{level="critical"}')).toBe(95);
    expect(parseGauge(METRICS, 'hdcontroller_storage_limit_percent{level="early"}')).toBe(80);
  });

  it("does not confuse a metric with a longer one sharing its prefix", () => {
    // hdcontroller_server_fill_percent must not satisfy a query for the
    // most-available gauge, and vice versa.
    expect(parseGauge(METRICS, "hdcontroller_write_protection_enabled")).toBe(1);
  });

  it("returns undefined for an absent metric rather than 0", () => {
    expect(parseGauge(METRICS, "hdcontroller_not_a_real_metric")).toBeUndefined();
  });
});

describe("readArtescaCapacity", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("armed but below the guard is HEALTHY, not refused", async () => {
    const r = await read(metricsWithFill(83.5401152611114, 1));
    expect(r?.writeProtectionArmed).toBe(true);
    expect(r?.writesRefused).toBe(false);
    expect(r?.warning).toBe(true); // 83.54 is over the 80 early line
  });

  it("armed and at the guard means writes are refused", async () => {
    const r = await read(metricsWithFill(95.01474620595619, 1));
    expect(r?.writesRefused).toBe(true);
    expect(r?.warning).toBe(false); // critical supersedes the warning band
  });

  it("disarmed at critical fill does NOT report refusal", async () => {
    const r = await read(metricsWithFill(97, 0));
    expect(r?.writeProtectionArmed).toBe(false);
    expect(r?.writesRefused).toBe(false);
  });

  it("comfortably below the early line is neither warning nor refused", async () => {
    const r = await read(metricsWithFill(42, 1));
    expect(r?.warning).toBe(false);
    expect(r?.writesRefused).toBe(false);
  });

  it("an unreachable hyperdrive is null, never a healthy reading", async () => {
    expect(await read(null)).toBeNull();
  });

  it("a non-200 from hdproxyd is null, never a healthy reading", async () => {
    expect(await read(METRICS, false)).toBeNull();
  });

  it("metrics without the fill gauge are null rather than 0% full", async () => {
    expect(await read("# nothing useful here\n")).toBeNull();
  });
});
