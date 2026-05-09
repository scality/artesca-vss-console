// GET /api/logs/[ns]/[pod]/[container]
// SSE: streams kubectl logs -f (k8s mode) or docker logs -f (docker mode).
// In docker mode `ns` is ignored; `pod` is treated as the container name.
// Query params:
//   tailLines  (number, default 100)
//   timestamps (bool,   default false)

import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createSseResponse } from "@/lib/streams/sse";
import { streamDockerLogs } from "@/lib/helpers/docker-sock";
import { KubeConfig, Log } from "@kubernetes/client-node";
import { PassThrough } from "stream";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_NAMESPACES = ["vst", "rtvi", "agent", "alerts", "demo-data", "pyramid-ingress", "console"];

function getAllowedNamespaces(): Set<string> {
  const raw = process.env.KUBE_NAMESPACES;
  if (!raw || raw.trim() === "") return new Set(DEFAULT_NAMESPACES);
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

interface RouteParams {
  params: Promise<{ ns: string; pod: string; container: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { ns, pod, container } = await params;

  if (!getAllowedNamespaces().has(ns)) {
    return NextResponse.json({ error: "namespace not in allowlist" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const tailLines = Math.min(
    Math.max(1, parseInt(sp.get("tailLines") ?? "100", 10)),
    5_000
  );
  const timestamps = sp.get("timestamps") === "true";

  if (process.env.CONSOLE_RUNTIME === "docker") {
    return createSseResponse<{ ts: string; line: string }>(
      req.signal,
      async (write) => {
        void ns; // ignored in docker mode
        void container; // docker logs combines stdout+stderr; container param is unused
        const destroy = streamDockerLogs(
          pod,
          { tail: tailLines, timestamps },
          (line) => write({ ts: new Date().toISOString(), line }),
          req.signal,
        );
        return destroy;
      },
    );
  }

  return createSseResponse<{ ts: string; line: string }>(
    req.signal,
    async (write) => {
      const kc = new KubeConfig();
      try {
        kc.loadFromCluster();
      } catch {
        kc.loadFromDefault();
      }

      const log = new Log(kc);
      const passthrough = new PassThrough();

      // Bridge Node.js stream → SSE.
      let buffer = "";
      passthrough.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.length > 0) {
            write({ ts: new Date().toISOString(), line });
          }
        }
      });

      // Flush remaining buffer on stream end.
      passthrough.on("end", () => {
        if (buffer.length > 0) {
          write({ ts: new Date().toISOString(), line: buffer });
          buffer = "";
        }
      });

      let k8sController: AbortController | null = null;
      let destroyed = false;

      const destroyStream = () => {
        if (!destroyed) {
          destroyed = true;
          k8sController?.abort();
          passthrough.destroy();
        }
      };

      req.signal.addEventListener("abort", destroyStream, { once: true });

      try {
        // log() returns immediately with an AbortController — streaming happens
        // asynchronously via the `passthrough` Writable. Wire stream end → cleanup.
        k8sController = await log.log(ns, pod, container, passthrough, {
          follow: true,
          tailLines,
          timestamps,
          pretty: false,
          previous: false,
        });
      } catch (err) {
        if (!req.signal.aborted) {
          write({
            ts: new Date().toISOString(),
            line: `[console] log stream error: ${String(err)}`,
          });
        }
        destroyStream();
      }

      // Keep the SSE stream alive until the client disconnects or the pod log ends.
      passthrough.on("end", destroyStream);
      passthrough.on("error", destroyStream);

      return destroyStream;
    }
  );
}
