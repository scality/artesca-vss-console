// tests/unit/clip-cache.test.ts
// Unit tests for src/lib/streams/clip-cache.ts — disk LRU cache helpers.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";

// ─── Capture real fs + create vi.fn() stubs — all inside vi.hoisted() ────────
//
// Vitest hoists vi.mock() calls above all imports (including this file's own
// top-level import statements).  vi.hoisted() runs even earlier than that,
// which means we can:
//   1. Capture the REAL fs functions before any mock replaces them.
//   2. Create vi.fn() wrappers that initially delegate to the real fns.
//   3. Reference those wrappers inside the vi.mock("fs") factory below.
//
// This avoids the infinite-recursion problem that arises when `import * as
// realFs from "fs"` resolves to the *mocked* module.

const {
  real,          // real (unmocked) fs functions captured at hoist time
  statSyncFn,
  readdirSyncFn,
  existsSyncFn,
  mkdirSyncFn,
  writeFileSyncFn,
  utimesSyncFn,
  rmSyncFn,
} = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const real = require("fs") as typeof import("fs");

  return {
    real,
    statSyncFn:      vi.fn((...args: Parameters<typeof real.statSync>)      => real.statSync(...args)),
    readdirSyncFn:   vi.fn((...args: Parameters<typeof real.readdirSync>)   => real.readdirSync(...args)),
    existsSyncFn:    vi.fn((p: import("fs").PathLike)                       => real.existsSync(p)),
    mkdirSyncFn:     vi.fn((...args: Parameters<typeof real.mkdirSync>)     => real.mkdirSync(...args)),
    writeFileSyncFn: vi.fn((...args: Parameters<typeof real.writeFileSync>) => real.writeFileSync(...args)),
    utimesSyncFn:    vi.fn((...args: Parameters<typeof real.utimesSync>)    => real.utimesSync(...args)),
    rmSyncFn:        vi.fn((...args: Parameters<typeof real.rmSync>)        => real.rmSync(...args)),
  };
});

vi.mock("fs", () => ({
  statSync:      statSyncFn,
  readdirSync:   readdirSyncFn,
  existsSync:    existsSyncFn,
  mkdirSync:     mkdirSyncFn,
  writeFileSync: writeFileSyncFn,
  utimesSync:    utimesSyncFn,
  rmSync:        rmSyncFn,
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Restore all stubs to their real-fs-delegating defaults. */
function restoreDefaults(): void {
  statSyncFn.mockImplementation      ((...a: Parameters<typeof real.statSync>)      => real.statSync(...a));
  readdirSyncFn.mockImplementation   ((...a: Parameters<typeof real.readdirSync>)   => real.readdirSync(...a));
  existsSyncFn.mockImplementation    ((p: import("fs").PathLike)                    => real.existsSync(p));
  mkdirSyncFn.mockImplementation     ((...a: Parameters<typeof real.mkdirSync>)     => real.mkdirSync(...a));
  writeFileSyncFn.mockImplementation ((...a: Parameters<typeof real.writeFileSync>) => real.writeFileSync(...a));
  utimesSyncFn.mockImplementation    ((...a: Parameters<typeof real.utimesSync>)    => real.utimesSync(...a));
  rmSyncFn.mockImplementation        ((...a: Parameters<typeof real.rmSync>)        => real.rmSync(...a));
}

let tmpRoot: string;

function makeTmpDir(): string {
  const dir = path.join(os.tmpdir(), `clip-cache-test-${randomUUID()}`);
  real.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanTmpDir(): void {
  if (tmpRoot) real.rmSync(tmpRoot, { recursive: true, force: true });
}

// ─── Populate a fake cache dir (real disk) ────────────────────────────────────

interface FakeEntry {
  name: string;
  sizeBytes: number;
  /** Epoch ms — smaller = older */
  mtimeOffsetMs: number;
}

function populateCache(cacheRoot: string, entries: FakeEntry[]): void {
  real.mkdirSync(cacheRoot, { recursive: true });
  for (const { name, sizeBytes, mtimeOffsetMs } of entries) {
    const dir = path.join(cacheRoot, name);
    real.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "index.m3u8");
    real.writeFileSync(filePath, Buffer.alloc(sizeBytes));
    const mtime = new Date(mtimeOffsetMs);
    real.utimesSync(filePath, mtime, mtime);
    real.utimesSync(dir, mtime, mtime);
  }
}

// ─── cacheDir / cachePath ─────────────────────────────────────────────────────

describe("cacheDir / cachePath", () => {
  beforeEach(() => {
    tmpRoot = makeTmpDir();
    process.env.CONSOLE_DATA_DIR = tmpRoot;
    vi.resetModules();
    restoreDefaults();
  });

  afterEach(() => {
    cleanTmpDir();
    delete process.env.CONSOLE_DATA_DIR;
  });

  it("cacheDir returns a path rooted inside CONSOLE_DATA_DIR/clip-cache", async () => {
    const { cacheDir } = await import("@/lib/streams/clip-cache");
    const result = cacheDir("checkout-1", "2026-05-01T00:00:00Z");
    expect(result).toContain("clip-cache");
    expect(result).toContain("checkout-1");
  });

  it("cachePath returns path with basename of the file arg", async () => {
    const { cachePath } = await import("@/lib/streams/clip-cache");
    const p = cachePath("checkout-1", "2026-05-01T00:00:00Z", "index.m3u8");
    expect(p.endsWith("index.m3u8")).toBe(true);
  });

  it("sanitizes sensor names with slashes — resulting dir stays inside clip-cache", async () => {
    const { cacheDir } = await import("@/lib/streams/clip-cache");
    const cacheRoot = path.join(tmpRoot, "clip-cache");

    const result = cacheDir("../../etc/passwd", "ts");

    // The resolved path must be a child of cacheRoot — no traversal.
    const resolved = path.resolve(result);
    const resolvedRoot = path.resolve(cacheRoot);
    expect(resolved.startsWith(resolvedRoot)).toBe(true);
  });
});

// ─── evictLru ─────────────────────────────────────────────────────────────────

describe("evictLru", () => {
  beforeEach(() => {
    tmpRoot = makeTmpDir();
    process.env.CONSOLE_DATA_DIR = tmpRoot;
    vi.resetModules();
    restoreDefaults();
  });

  afterEach(() => {
    cleanTmpDir();
    delete process.env.CONSOLE_DATA_DIR;
  });

  // ── 1. Eviction removes oldest entries ────────────────────────────────────

  it("evicts the oldest entries until total drops below the threshold", async () => {
    const cacheRoot = path.join(tmpRoot, "clip-cache");
    const GiB = 1024 * 1024 * 1024;

    // Create real (tiny) on-disk directories.
    populateCache(cacheRoot, [
      { name: "entry-A", sizeBytes: 1, mtimeOffsetMs: 1_000 }, // oldest
      { name: "entry-B", sizeBytes: 1, mtimeOffsetMs: 2_000 },
      { name: "entry-C", sizeBytes: 1, mtimeOffsetMs: 3_000 }, // newest
    ]);

    // Override statSync to return large synthetic sizes so eviction triggers.
    // Total: A(2GiB) + B(2GiB) + C(1GiB) = 5GiB > 4.5GiB threshold.
    // After evicting A(oldest): 3GiB ≤ 4.5GiB → stop.
    //
    // IMPORTANT: spread loses prototype methods (isDirectory, isFile, etc.).
    // Patch only the fields the module reads; keep prototype methods via
    // Object.create + Object.assign.
    statSyncFn.mockImplementation((...args: Parameters<typeof real.statSync>) => {
      const p = String(args[0]);
      const r = real.statSync(...args) as import("fs").Stats;
      if (p.includes("entry-A")) {
        return Object.assign(
          Object.create(Object.getPrototypeOf(r) as object) as import("fs").Stats,
          r, { size: 2 * GiB, mtimeMs: 1_000 },
        );
      }
      if (p.includes("entry-B")) {
        return Object.assign(
          Object.create(Object.getPrototypeOf(r) as object) as import("fs").Stats,
          r, { size: 2 * GiB, mtimeMs: 2_000 },
        );
      }
      if (p.includes("entry-C")) {
        return Object.assign(
          Object.create(Object.getPrototypeOf(r) as object) as import("fs").Stats,
          r, { size: 1 * GiB, mtimeMs: 3_000 },
        );
      }
      return r;
    });

    const { evictLru } = await import("@/lib/streams/clip-cache");
    await evictLru();

    // Oldest entry deleted; B and C survive.
    expect(real.existsSync(path.join(cacheRoot, "entry-A"))).toBe(false);
    expect(real.existsSync(path.join(cacheRoot, "entry-B"))).toBe(true);
    expect(real.existsSync(path.join(cacheRoot, "entry-C"))).toBe(true);
  });

  // ── 2. Missing cache dir is a no-op ───────────────────────────────────────

  it("returns without error when the cache directory does not exist", async () => {
    // Don't create the clip-cache subdir.
    const { evictLru } = await import("@/lib/streams/clip-cache");
    await expect(evictLru()).resolves.toBeUndefined();
  });

  // ── 3. Under threshold: no deletions ─────────────────────────────────────

  it("makes no deletions when total size is below the threshold", async () => {
    const cacheRoot = path.join(tmpRoot, "clip-cache");

    // Small real files — well under 4.5 GiB.
    populateCache(cacheRoot, [
      { name: "clip-1", sizeBytes: 512, mtimeOffsetMs: 1_000 },
      { name: "clip-2", sizeBytes: 512, mtimeOffsetMs: 2_000 },
    ]);

    const { evictLru } = await import("@/lib/streams/clip-cache");
    await evictLru();

    expect(real.existsSync(path.join(cacheRoot, "clip-1"))).toBe(true);
    expect(real.existsSync(path.join(cacheRoot, "clip-2"))).toBe(true);
  });

  // ── 4. Concurrent calls serialise ─────────────────────────────────────────

  it("serialises concurrent calls — doEvictLru runs sequentially", async () => {
    // walkCacheEntries() calls existsSync(CACHE_ROOT) first — make it return
    // true so it proceeds to readdirSync (which we count to verify both calls).
    const cacheRoot = path.join(tmpRoot, "clip-cache");
    real.mkdirSync(cacheRoot, { recursive: true });

    const callOrder: number[] = [];
    let seq = 0;

    readdirSyncFn.mockImplementation(() => {
      callOrder.push(++seq);
      return [] as unknown as ReturnType<typeof real.readdirSync>;
    });

    const { evictLru } = await import("@/lib/streams/clip-cache");

    const p1 = evictLru();
    const p2 = evictLru();

    await Promise.all([p1, p2]);

    // Both doEvictLru calls must have run — one for each evictLru invocation.
    expect(callOrder.length).toBeGreaterThanOrEqual(2);
  });

  // ── 5. Error in doEvictLru: chain stays usable, console.error logged ──────

  it("chain stays usable after doEvictLru throws; console.error is called", async () => {
    // Create the cache root directory so walkCacheEntries proceeds to readdirSync.
    const cacheRoot = path.join(tmpRoot, "clip-cache");
    real.mkdirSync(cacheRoot, { recursive: true });

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => void 0);

    let firstCall = true;
    readdirSyncFn.mockImplementation(() => {
      if (firstCall) {
        firstCall = false;
        throw new Error("EACCES: permission denied");
      }
      return [] as unknown as ReturnType<typeof real.readdirSync>;
    });

    const { evictLru } = await import("@/lib/streams/clip-cache");

    // First call fails internally → .catch() logs it.
    await evictLru();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[clip-cache]"),
      expect.anything(),
    );

    // Second call must still work (chain is not permanently broken).
    await expect(evictLru()).resolves.toBeUndefined();
  });
});
