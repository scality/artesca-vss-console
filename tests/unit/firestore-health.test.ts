import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { firestoreHealthCheck } from "@/lib/config-store/firestore";

// server-only is stubbed globally in tests/setup.ts.

const ORIG = { ...process.env };
beforeEach(() => {
  process.env = { ...ORIG };
  delete process.env.FIRESTORE_PROJECT_ID;
  delete process.env.GOOGLE_CLOUD_PROJECT;
  delete process.env.FIRESTORE_DATABASE_ID;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
});
afterEach(() => {
  process.env = { ...ORIG };
});

const okStore = () =>
  Promise.resolve({
    readPromptSets: async () => [{ id: "default", name: "x", text: "y" }],
    readCameras: async () => [{ id: "c1", rtspUrl: "rtsp://x/c1" }],
    readScenarios: async () => [],
  } as never);

describe("firestoreHealthCheck", () => {
  it("reports no-credentials when GOOGLE_APPLICATION_CREDENTIALS is unset", async () => {
    const r = await firestoreHealthCheck("i1", okStore);
    expect(r.status).toBe("no-credentials");
    expect(r.project).toBe("isv-alliances");
    expect(r.database).toBe("(default)");
    expect(r.counts).toBeUndefined();
  });

  it("reports error when the instance is empty", async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "/etc/config-store/key.json";
    const r = await firestoreHealthCheck("", okStore);
    expect(r.status).toBe("error");
    expect(r.detail).toContain("VSS_INSTANCE_NAME");
  });

  it("reports ok with per-collection counts from the store", async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "/etc/config-store/key.json";
    const r = await firestoreHealthCheck("i1", okStore);
    expect(r.status).toBe("ok");
    expect(r.counts).toEqual({ promptSets: 1, cameras: 1, scenarios: 0 });
  });

  it("reports error (fail-soft, never throws) when a store read rejects", async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "/etc/config-store/key.json";
    const r = await firestoreHealthCheck("i1", async () => {
      throw new Error("permission denied");
    });
    expect(r.status).toBe("error");
    expect(r.detail).toContain("permission denied");
  });

  it("honors FIRESTORE_PROJECT_ID / FIRESTORE_DATABASE_ID overrides", async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "/etc/config-store/key.json";
    process.env.FIRESTORE_PROJECT_ID = "proj-x";
    process.env.FIRESTORE_DATABASE_ID = "db-x";
    const r = await firestoreHealthCheck("i1", okStore);
    expect(r.project).toBe("proj-x");
    expect(r.database).toBe("db-x");
  });
});
