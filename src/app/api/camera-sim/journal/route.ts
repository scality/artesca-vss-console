// GET /api/camera-sim/journal
// SSE: SSH to camera-sim EC2 and stream `sudo journalctl -fu camera-sim --output=json`.
// Each JSON line from journalctl is parsed and emitted as an SSE event.
// Auth required. Disconnects clean the SSH stream.

import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createSseResponse } from "@/lib/streams/sse";
import { Client, type ConnectConfig } from "ssh2";
import * as fs from "fs";

interface JournalEntry {
  ts: string;
  message: string;
  priority?: number;
  unit?: string;
  [key: string]: unknown;
}

function getConnectConfig(): ConnectConfig {
  return {
    host: process.env.CAMERA_SIM_HOST ?? "",
    username: process.env.CAMERA_SIM_SSH_USER ?? "ubuntu",
    privateKey: fs.readFileSync(
      process.env.CAMERA_SIM_SSH_KEY_PATH ?? "/run/secrets/camera-sim-ssh-key"
    ),
    readyTimeout: 10_000,
  };
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return createSseResponse<JournalEntry>(req.signal, (write) => {
    return new Promise<() => void>((resolve, reject) => {
      const conn = new Client();
      let sshStream: { destroy: () => void } | null = null;
      let resolved = false;

      const cleanup = () => {
        if (sshStream) {
          try {
            sshStream.destroy();
          } catch {
            /* ignore */
          }
        }
        conn.end();
      };

      req.signal.addEventListener("abort", cleanup, { once: true });

      conn.on("ready", () => {
        // journalctl is a fixed command — no user input is interpolated here.
        conn.exec(
          "sudo journalctl -fu camera-sim --output=json --no-pager",
          (err, stream) => {
            if (err) {
              conn.end();
              return reject(err);
            }

            sshStream = stream;

            // Provide cleanup to the SSE factory before blocking on stream data.
            if (!resolved) {
              resolved = true;
              resolve(cleanup);
            }

            let buffer = "";

            stream.on("data", (chunk: Buffer) => {
              if (req.signal.aborted) return;
              buffer += chunk.toString("utf8");
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              for (const line of lines) {
                if (!line.trim()) continue;
                let parsed: JournalEntry;
                try {
                  // journalctl --output=json uses UPPERCASE_KEYS by convention.
                  const raw = JSON.parse(line) as Record<string, unknown>;
                  parsed = {
                    ts:
                      typeof raw.__REALTIME_TIMESTAMP === "string"
                        ? new Date(
                            Math.round(
                              parseInt(raw.__REALTIME_TIMESTAMP, 10) / 1_000
                            )
                          ).toISOString()
                        : new Date().toISOString(),
                    message: String(raw.MESSAGE ?? ""),
                    priority:
                      typeof raw.PRIORITY === "string"
                        ? parseInt(raw.PRIORITY, 10)
                        : undefined,
                    unit: raw._SYSTEMD_UNIT as string | undefined,
                  };
                } catch {
                  parsed = { ts: new Date().toISOString(), message: line };
                }
                write(parsed);
              }
            });

            stream.stderr.on("data", (chunk: Buffer) => {
              if (req.signal.aborted) return;
              const text = chunk.toString("utf8").trim();
              if (text) {
                write({ ts: new Date().toISOString(), message: "[stderr] " + text });
              }
            });

            stream.on("close", () => {
              conn.end();
            });
          }
        );
      });

      conn.on("error", (err) => {
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });

      conn.connect(getConnectConfig());
    });
  });
}
