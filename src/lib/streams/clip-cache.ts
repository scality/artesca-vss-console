// src/lib/streams/clip-cache.ts
// Cache management for HLS clips transcoded from S3/VST sources.
// PVC quota: 5 GiB — simple LRU eviction when over threshold.

import * as fs from "fs";
import * as path from "path";

/** 24-hour freshness TTL (ms) */
export const CLIP_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

/** Evict when cache dir exceeds 4.5 GiB (leaving buffer below the 5 GiB PVC). */
const MAX_CACHE_BYTES = 4.5 * 1024 * 1024 * 1024;

const DATA_DIR =
  process.env.CONSOLE_DATA_DIR !== undefined
    ? process.env.CONSOLE_DATA_DIR
    : "/data";

const CACHE_ROOT = path.join(DATA_DIR, "clip-cache");

/** Sanitize a path component against traversal attacks. */
function sanitize(s: string): string {
  // Allow alphanumerics, hyphens, underscores, colons, dots, plus signs (ISO 8601).
  // Reject anything that could navigate the filesystem.
  const clean = s.replace(/[^A-Za-z0-9_\-:.+]/g, "_");
  // Collapse sequences of underscores/dots that result from replacement.
  return clean.substring(0, 128);
}

/** Return the cache directory for a given sensor + timestamp key. */
export function cacheDir(sensor: string, ts: string): string {
  return path.join(CACHE_ROOT, `${sanitize(sensor)}-${sanitize(ts)}`);
}

/** Return a full path for a file inside the clip cache. */
export function cachePath(sensor: string, ts: string, file: string): string {
  const dir = cacheDir(sensor, ts);
  // Prevent sub-path traversal inside the cache dir.
  const safe = path.basename(file);
  return path.join(dir, safe);
}

/** True when the file exists AND is newer than `ttlMs`. */
export function isCacheFresh(filePath: string, ttlMs = CLIP_CACHE_TTL_MS): boolean {
  try {
    const stat = fs.statSync(filePath);
    return Date.now() - stat.mtimeMs < ttlMs;
  } catch {
    return false;
  }
}

/** Ensure the cache directory for a clip exists. */
export function ensureCacheDir(sensor: string, ts: string): string {
  const dir = cacheDir(sensor, ts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

interface DirEntry {
  dir: string;
  sizeBytes: number;
  mtimeMs: number;
}

/** Walk cache root, return per-clip-dir entries sorted oldest→newest. */
function walkCacheEntries(): DirEntry[] {
  if (!fs.existsSync(CACHE_ROOT)) return [];

  const entries: DirEntry[] = [];
  for (const name of fs.readdirSync(CACHE_ROOT)) {
    const dir = path.join(CACHE_ROOT, name);
    try {
      const dirStat = fs.statSync(dir);
      if (!dirStat.isDirectory()) continue;

      let sizeBytes = 0;
      let mtimeMs = dirStat.mtimeMs;

      for (const file of fs.readdirSync(dir)) {
        const filePath = path.join(dir, file);
        const fStat = fs.statSync(filePath);
        sizeBytes += fStat.size;
        if (fStat.mtimeMs > mtimeMs) mtimeMs = fStat.mtimeMs;
      }

      entries.push({ dir, sizeBytes, mtimeMs });
    } catch {
      // Skip unreadable entries.
    }
  }

  // Oldest first — these are evicted first.
  return entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/**
 * Evict oldest cache entries until total usage drops below MAX_CACHE_BYTES.
 * Called after each transcoding job completes.
 */
export function evictLru(): void {
  const entries = walkCacheEntries();
  let total = entries.reduce((s, e) => s + e.sizeBytes, 0);

  for (const entry of entries) {
    if (total <= MAX_CACHE_BYTES) break;
    try {
      fs.rmSync(entry.dir, { recursive: true, force: true });
      total -= entry.sizeBytes;
    } catch {
      // Best-effort.
    }
  }
}

/** Resolve the canonical ISO timestamp rounded to the nearest 10-second boundary. */
export function roundTs(ts: string): Date {
  const d = new Date(ts);
  const ms = d.getTime();
  const rounded = Math.round(ms / 10_000) * 10_000;
  return new Date(rounded);
}
