/**
 * Minimal HTTP client for the local Docker daemon socket. Used by routes
 * that introspect or recreate compose containers when the console runs
 * with /var/run/docker.sock mounted (CONSOLE_RUNTIME=docker).
 *
 * Bounded timeout — callers shouldn't block the dashboard on a hung
 * daemon. Errors include the response body for debuggability.
 */
import "server-only";
import http from "node:http";

export async function dockerSock(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  timeoutMs = 8_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath: "/var/run/docker.sock",
        path,
        method,
        timeout: timeoutMs,
        headers: payload
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload).toString(),
            }
          : undefined,
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(
              new Error(
                `docker.sock ${method} ${path}: ${res.statusCode} ${buf.slice(0, 300)}`,
              ),
            );
            return;
          }
          if (!buf.trim()) {
            resolve({});
            return;
          }
          try {
            resolve(JSON.parse(buf));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`docker.sock timeout (${path})`)));
    if (payload) req.write(payload);
    req.end();
  });
}

export interface ComposeContainer {
  Id: string;
  Names: string[];
  Image: string;
  State: string; // "running" | "exited" | ...
  Status: string; // human "Up 4 hours (healthy)"
  Labels: Record<string, string>;
}

/** List containers belonging to a compose project. Empty array on error. */
export async function listComposeContainers(
  project: string,
): Promise<ComposeContainer[]> {
  const filters = encodeURIComponent(
    JSON.stringify({ label: [`com.docker.compose.project=${project}`] }),
  );
  try {
    const list = (await dockerSock(
      "GET",
      `/containers/json?all=1&filters=${filters}`,
    )) as ComposeContainer[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export interface ContainerInspect {
  Id: string;
  State: { Status: string; Running: boolean; Health?: { Status: string } };
  Config: { Image: string; Env: string[] };
}

export async function inspectContainer(
  name: string,
): Promise<ContainerInspect | null> {
  try {
    return (await dockerSock(
      "GET",
      `/containers/${encodeURIComponent(name)}/json`,
    )) as ContainerInspect;
  } catch {
    return null;
  }
}

/** Run a command in a running container via the Exec API. Returns stdout
 *  on success (stderr is silently dropped — caller should design commands
 *  that emit the answer to stdout). Returns null on any failure. */
export async function execInContainer(
  name: string,
  cmd: string[],
  timeoutMs = 8_000,
): Promise<string | null> {
  try {
    const created = (await dockerSock(
      "POST",
      `/containers/${encodeURIComponent(name)}/exec`,
      {
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        Cmd: cmd,
      },
      timeoutMs,
    )) as { Id: string };

    // /exec/start streams a multiplexed output frame format. We need the raw
    // stream this time (not the JSON wrapper), so do the request manually.
    const stdout = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        {
          socketPath: "/var/run/docker.sock",
          path: `/exec/${created.Id}/start`,
          method: "POST",
          timeout: timeoutMs,
          headers: { "content-type": "application/json" },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            // Demultiplex docker's stream frame: 8-byte header per chunk
            // (stream type byte + 3 zero pad + 4-byte BE length).
            const buf = Buffer.concat(chunks);
            let out = "";
            let i = 0;
            while (i + 8 <= buf.length) {
              const stream = buf[i];
              const len = buf.readUInt32BE(i + 4);
              i += 8;
              if (i + len > buf.length) break;
              if (stream === 1) out += buf.subarray(i, i + len).toString("utf8");
              i += len;
            }
            resolve(out);
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("exec timeout")));
      req.write(JSON.stringify({ Detach: false, Tty: false }));
      req.end();
    });
    return stdout;
  } catch {
    return null;
  }
}
