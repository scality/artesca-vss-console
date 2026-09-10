import "server-only";
import { connect } from "node:net";

const TIMEOUT_MS = 3_000;

/**
 * Does the RTSP source answer? One OPTIONS request over a fresh TCP connection,
 * true on any `RTSP/1.0 2xx` status line. Authentication is not attempted: a
 * 401 still proves the server is up, which is the question — a sensor VST
 * marked offline at boot because the source was slow to answer looks exactly
 * like a dead camera to VST, and this tells the two apart.
 */
export function rtspSourceAnswers(rtspUrl: string): Promise<boolean> {
  let host: string;
  let port: number;
  try {
    const u = new URL(rtspUrl);
    host = u.hostname;
    port = u.port ? Number(u.port) : 554;
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    const socket = connect({ host, port });
    socket.setTimeout(TIMEOUT_MS, () => done(false));
    socket.once("error", () => done(false));
    socket.once("connect", () => {
      socket.write(`OPTIONS ${rtspUrl} RTSP/1.0\r\nCSeq: 1\r\n\r\n`);
    });
    socket.once("data", (chunk) => done(/^RTSP\/1\.[01] [2-4]\d\d/.test(chunk.toString("latin1"))));
  });
}
