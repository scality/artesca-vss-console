import "server-only";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

// Test footage: replay a local video file through the REAL pipeline (RTSP →
// VST → recording → rtvi-vlm → Kafka → alert worker) so a VLM prompt and an
// alert scenario can be judged on actual frames.
//
// Files land on a PVC shared with test-footage-server, which republishes each
// one as RTSP on demand (see k8s/console/30-test-footage.yaml). Starting a run
// is therefore just registering a VST camera at the right URL — there is no
// process to supervise and a crashed run cannot leak an ffmpeg.

/** Directory the test-footage PVC is mounted at inside the console pod. */
export const FOOTAGE_DIR = process.env.TEST_FOOTAGE_DIR ?? "/footage";

/** Host VST dials for the replay stream. The replay server shares the node's
 *  network namespace with VST on the converged node, so loopback is correct;
 *  overridable for a split-node topology. */
const RTSP_HOST = process.env.TEST_FOOTAGE_RTSP_HOST ?? "127.0.0.1";
const RTSP_PORT = process.env.TEST_FOOTAGE_RTSP_PORT ?? "8654";

/** Container formats ffmpeg can remux into RTSP with `-c copy`. */
const ALLOWED_EXTENSIONS = [".mp4", ".ts", ".mkv", ".mov", ".webm"] as const;

/** Upload ceiling. Large enough for a few minutes of store footage, small
 *  enough that a mistaken upload cannot fill the 20 Gi volume in one request. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

export type PlaybackMode = "loop" | "once";

export interface FootageFile {
  /** Sanitised on-disk name; also the RTSP path segment. */
  name: string;
  sizeBytes: number;
  uploadedAt: string;
}

export class FootageError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "FootageError";
  }
}

/**
 * Make an operator-supplied filename safe to use as both a path segment on disk
 * and a segment of an RTSP URL. Rejects rather than silently mangles when the
 * result would be empty or the extension is not remuxable — a surprising
 * rename is worse than a clear error.
 */
export function sanitiseFilename(raw: string): string {
  // Basename only: defeats "../" and any directory component.
  const base = raw.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot).toLowerCase() : "";
  const stem = dot > 0 ? base.slice(0, dot) : base;

  if (!ALLOWED_EXTENSIONS.includes(ext as (typeof ALLOWED_EXTENSIONS)[number])) {
    throw new FootageError(
      `unsupported video format "${ext || base}" — use one of ${ALLOWED_EXTENSIONS.join(", ")}`,
      400,
    );
  }

  const slug = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

  if (!slug) throw new FootageError(`filename "${raw}" has no usable characters`, 400);
  return `${slug}${ext}`;
}

/** Camera id a run registers in VST. Prefixed so it is obviously synthetic in
 *  the camera list, the incident feed and any scenario sensor filter. */
export function footageCameraId(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, "");
  return `test-${stem}`.slice(0, 32);
}

/** RTSP URL the replay server answers for this file in the requested mode. */
export function footageRtspUrl(fileName: string, mode: PlaybackMode): string {
  // The path segment must survive URL parsing; sanitiseFilename already limits
  // it to [a-z0-9-] plus the extension dot.
  return `rtsp://${RTSP_HOST}:${RTSP_PORT}/${mode}/${fileName}`;
}

/** True when this camera id belongs to a test-footage run. */
export function isFootageCamera(cameraId: string): boolean {
  return cameraId.startsWith("test-");
}

export async function listFootage(): Promise<FootageFile[]> {
  let entries: string[];
  try {
    entries = await readdir(FOOTAGE_DIR);
  } catch (err) {
    const code = (err as { code?: string }).code;
    // Volume not mounted yet (or not present in a docker-mode console): an
    // empty list is the honest answer, not a 500.
    if (code === "ENOENT") return [];
    throw err;
  }

  const files: FootageFile[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    try {
      const st = await stat(join(FOOTAGE_DIR, name));
      if (!st.isFile()) continue;
      files.push({
        name,
        sizeBytes: st.size,
        uploadedAt: st.mtime.toISOString(),
      });
    } catch {
      // Raced with a delete — skip.
    }
  }
  return files.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

/**
 * Stream an upload to disk. Deliberately streamed rather than buffered: a
 * multi-hundred-MB video read into memory would push the 1 Gi console pod into
 * an OOM kill.
 */
export async function saveFootage(
  fileName: string,
  body: ReadableStream<Uint8Array>,
  declaredBytes?: number,
): Promise<FootageFile> {
  if (declaredBytes !== undefined && declaredBytes > MAX_UPLOAD_BYTES) {
    throw new FootageError(
      `file is ${(declaredBytes / 1e9).toFixed(1)} GB — the limit is ${MAX_UPLOAD_BYTES / 1e9} GB`,
      413,
    );
  }

  await mkdir(FOOTAGE_DIR, { recursive: true });
  const target = join(FOOTAGE_DIR, fileName);
  // Write to a temp name so a half-finished upload is never picked up as
  // playable footage, then rename into place.
  const tmp = `${target}.part`;

  let written = 0;
  const counted = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      written += chunk.byteLength;
      if (written > MAX_UPLOAD_BYTES) {
        controller.error(
          new FootageError(`upload exceeded the ${MAX_UPLOAD_BYTES / 1e9} GB limit`, 413),
        );
        return;
      }
      controller.enqueue(chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(body.pipeThrough(counted) as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(tmp),
    );
    const { rename } = await import("node:fs/promises");
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }

  const st = await stat(target);
  return { name: fileName, sizeBytes: st.size, uploadedAt: st.mtime.toISOString() };
}

export async function deleteFootage(fileName: string): Promise<void> {
  // Re-sanitise: never trust a path arriving from the client.
  const safe = sanitiseFilename(fileName);
  try {
    await unlink(join(FOOTAGE_DIR, safe));
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      throw new FootageError(`no such footage: ${safe}`, 404);
    }
    throw err;
  }
}
