import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:net";

vi.mock("server-only", () => ({}));
import { rtspSourceAnswers } from "./rtsp-probe";

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

function listen(reply: string | null): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((sock) => {
      sock.once("data", () => {
        if (reply !== null) sock.write(reply);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve((server!.address() as { port: number }).port));
  });
}

describe("rtspSourceAnswers", () => {
  it("is true for an RTSP 200 OPTIONS reply", async () => {
    const port = await listen("RTSP/1.0 200 OK\r\nCSeq: 1\r\nPublic: OPTIONS, DESCRIBE\r\n\r\n");
    expect(await rtspSourceAnswers(`rtsp://127.0.0.1:${port}/video0`)).toBe(true);
  });
  it("is true for a 401 — the server is up, credentials are not the question", async () => {
    const port = await listen("RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\n\r\n");
    expect(await rtspSourceAnswers(`rtsp://127.0.0.1:${port}/video0`)).toBe(true);
  });
  it("is false when nothing listens", async () => {
    const port = await listen(null);
    const closed = port;
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    expect(await rtspSourceAnswers(`rtsp://127.0.0.1:${closed}/video0`)).toBe(false);
  });
  it("is false for a URL that does not parse", async () => {
    expect(await rtspSourceAnswers("not a url")).toBe(false);
  });
});
