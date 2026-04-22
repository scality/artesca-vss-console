// src/lib/streams/ffmpeg.ts
// ffmpeg child-process wrapper with a bounded concurrency pool.
// NOTE: The Dockerfile must include `apt-get install -y ffmpeg` — this module
// does NOT bundle the binary. A missing binary causes a clear startup error.

import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";

/** Maximum simultaneous ffmpeg processes. */
const MAX_CONCURRENT = 2;

let activeCount = 0;
const queue: Array<() => void> = [];

function acquire(): Promise<void> {
  if (activeCount < MAX_CONCURRENT) {
    activeCount++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => queue.push(resolve));
}

function release(): void {
  const next = queue.shift();
  if (next) {
    next();
  } else {
    activeCount--;
  }
}

export interface FfmpegResult {
  code: number;
  stderr: string;
}

/**
 * Spawn ffmpeg with the given args, respecting the concurrency pool.
 * Resolves when the process exits. Rejects on spawn error.
 */
export async function spawnFfmpeg(args: string[]): Promise<FfmpegResult> {
  await acquire();
  return new Promise<FfmpegResult>((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      release();
      // Provide a clear message if ffmpeg is not installed.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            "ffmpeg binary not found — ensure the Docker image includes `apt-get install -y ffmpeg`"
          )
        );
      } else {
        reject(err);
      }
    });

    proc.on("close", (code) => {
      release();
      resolve({ code: code ?? 1, stderr });
    });
  });
}

/**
 * Transcode a local MP4/TS file to HLS segments in `outDir`.
 * Produces `index.m3u8` + `seg000.ts`, `seg001.ts`, …
 */
export async function transcodeToHls(
  inputPath: string,
  outDir: string,
  segmentDurationSecs = 2
): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true });

  const playlistPath = path.join(outDir, "index.m3u8");
  const segPattern = path.join(outDir, "seg%03d.ts");

  const args = [
    "-y",
    "-i",
    inputPath,
    "-c:v",
    "copy",
    "-c:a",
    "copy",
    "-hls_time",
    String(segmentDurationSecs),
    "-hls_list_size",
    "5",
    "-hls_segment_filename",
    segPattern,
    "-f",
    "hls",
    playlistPath,
  ];

  const { code, stderr } = await spawnFfmpeg(args);
  if (code !== 0) {
    throw new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`);
  }
}

/**
 * Extract a single JPEG thumbnail at `offsetSecs` into the file.
 * Writes to `thumbPath`.
 */
export async function extractThumbnail(
  inputPath: string,
  thumbPath: string,
  offsetSecs = 0
): Promise<void> {
  const args = [
    "-y",
    "-ss",
    String(offsetSecs),
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-vf",
    "scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2",
    "-q:v",
    "4",
    thumbPath,
  ];

  const { code, stderr } = await spawnFfmpeg(args);
  if (code !== 0) {
    throw new Error(`ffmpeg thumbnail failed ${code}: ${stderr.slice(-300)}`);
  }
}
