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
import nodePath from "node:path";

export const DOCKER_TUNING_DIR = nodePath.join(
  process.env.CONSOLE_DATA_DIR ?? "/data",
  ".docker-tuning",
);

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
  Name: string;
  RestartCount: number;
  State: {
    Status: string;
    Running: boolean;
    StartedAt: string;
    Health?: { Status: string };
  };
  Config: {
    Image: string;
    Env: string[];
    Labels: Record<string, string>;
  };
  NetworkSettings?: { IPAddress: string };
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

/** Spawn a one-shot container from `image` with `--gpus all`, run the given
 *  binary + args, capture stdout, then auto-remove. The container inherits
 *  the nvidia runtime + DeviceRequests asking for ALL GPUs (Count: -1) so
 *  it sees every GPU on the host — sidestepping the per-container
 *  DeviceIDs="0" pinning that hides GPUs 1..n from individual workload
 *  containers (e.g. rtvi-vlm only sees GPU 0).
 *
 *  Image must already be pulled on the host — callers should pick an
 *  image known to be local (one of the compose-stack images). Entrypoint
 *  is overridden to argv[0]; the remaining argv[1..] becomes Cmd. Without
 *  this, images like rtvi-vlm would run their service entrypoint and
 *  ignore our query.
 *
 *  Returns null on any failure. */
export async function runOneShotGpuContainer(
  image: string,
  argv: string[],
  timeoutMs = 8_000,
): Promise<string | null> {
  if (argv.length === 0) return null;
  let containerId: string | undefined;
  try {
    const created = (await dockerSock(
      "POST",
      "/containers/create",
      {
        Image: image,
        Entrypoint: [argv[0]],
        Cmd: argv.slice(1),
        Tty: false,
        AttachStdout: true,
        AttachStderr: true,
        HostConfig: {
          Runtime: "nvidia",
          AutoRemove: true,
          DeviceRequests: [
            {
              Driver: "nvidia",
              Count: -1,
              Capabilities: [["gpu"]],
            },
          ],
        },
      },
      timeoutMs,
    )) as { Id: string };
    containerId = created.Id;

    // Attach stream BEFORE start so we don't miss output (auto-remove racing
    // with /containers/<id>/logs has been observed to drop output).
    const attachPromise = new Promise<string>((resolve, reject) => {
      const req = http.request(
        {
          socketPath: "/var/run/docker.sock",
          path: `/containers/${created.Id}/attach?stream=1&stdout=1&stderr=1`,
          method: "POST",
          timeout: timeoutMs,
          headers: { "content-type": "application/vnd.docker.raw-stream" },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
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
      req.on("timeout", () => req.destroy(new Error("attach timeout")));
      req.end();
    });

    await dockerSock("POST", `/containers/${created.Id}/start`, undefined, timeoutMs);
    const stdout = await attachPromise;
    return stdout;
  } catch {
    if (containerId) {
      // best-effort cleanup if AutoRemove didn't fire (start failed)
      await dockerSock("DELETE", `/containers/${containerId}?force=1`).catch(() => undefined);
    }
    return null;
  }
}

/**
 * Stream logs from a running container via the Docker Engine socket.
 * Calls `onLine` for each line of log output (stdout + stderr combined).
 * Returns a cleanup function that terminates the stream.
 *
 * Docker multiplexes stdout/stderr in 8-byte framed chunks:
 *   [stream(1)] [pad(3)] [length(4 BE)] [data(length bytes)]
 * We buffer across Node.js data events and emit complete lines.
 */
export function streamDockerLogs(
  containerName: string,
  opts: { tail?: number; timestamps?: boolean },
  onLine: (line: string) => void,
  signal?: AbortSignal,
): () => void {
  const tail = opts.tail ?? 100;
  const path =
    `/containers/${encodeURIComponent(containerName)}/logs` +
    `?follow=1&stdout=1&stderr=1&tail=${tail}&timestamps=${opts.timestamps ? "1" : "0"}`;

  let buf = Buffer.alloc(0);
  let frameSize = -1; // -1 means we are reading a new 8-byte header

  const req = http.request(
    { socketPath: "/var/run/docker.sock", path, method: "GET" },
    (res) => {
      res.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        while (true) {
          if (frameSize < 0) {
            if (buf.length < 8) break;
            frameSize = buf.readUInt32BE(4);
            buf = buf.subarray(8);
          }
          if (buf.length < frameSize) break;
          const text = buf.subarray(0, frameSize).toString("utf8");
          buf = buf.subarray(frameSize);
          frameSize = -1;
          for (const line of text.split("\n")) {
            if (line.length > 0) onLine(line);
          }
        }
      });
    },
  );

  req.on("error", () => {}); // suppress on destroy
  req.end();

  const destroy = () => req.destroy();
  signal?.addEventListener("abort", destroy, { once: true });
  return destroy;
}

/** Recreate the named container with patched env vars, preserving image,
 *  entrypoint, mounts, network mode, GPU device requests, restart policy,
 *  exposed ports, and compose labels.
 *
 *  Strategy: stop → rename old to <name>-bak-<ts> → create new from patched
 *  config → start new. If start fails, the new container is removed and the
 *  old one is renamed back + started. */
export async function dockerRecreateWithEnv(
  name: string,
  envOverrides: Record<string, string>,
): Promise<{ id: string }> {
  const inspect = (await dockerSock("GET", `/containers/${encodeURIComponent(name)}/json`)) as {
    Config: {
      Image: string;
      Env: string[];
      Cmd: string[] | null;
      Entrypoint: string[] | null;
      ExposedPorts?: Record<string, unknown>;
      Labels?: Record<string, string>;
      WorkingDir?: string;
      User?: string;
    };
    HostConfig: Record<string, unknown>;
    NetworkSettings: { Networks: Record<string, unknown> };
  };

  const seen = new Set<string>();
  const newEnv: string[] = [];
  for (const line of inspect.Config.Env ?? []) {
    const eq = line.indexOf("=");
    const k = eq > 0 ? line.slice(0, eq) : line;
    if (k in envOverrides) {
      newEnv.push(`${k}=${envOverrides[k]}`);
      seen.add(k);
    } else {
      newEnv.push(line);
    }
  }
  for (const [k, v] of Object.entries(envOverrides)) {
    if (!seen.has(k)) newEnv.push(`${k}=${v}`);
  }

  const networks = Object.keys(inspect.NetworkSettings?.Networks ?? {});
  const networkingConfig =
    networks.length > 0
      ? { EndpointsConfig: Object.fromEntries(networks.map((n) => [n, {}])) }
      : undefined;

  const createBody: Record<string, unknown> = {
    Image: inspect.Config.Image,
    Env: newEnv,
    Cmd: inspect.Config.Cmd,
    Entrypoint: inspect.Config.Entrypoint,
    ExposedPorts: inspect.Config.ExposedPorts,
    Labels: inspect.Config.Labels,
    WorkingDir: inspect.Config.WorkingDir,
    User: inspect.Config.User,
    HostConfig: inspect.HostConfig,
    ...(networkingConfig ? { NetworkingConfig: networkingConfig } : {}),
  };

  const ts = Date.now();
  const backupName = `${name}-bak-${ts}`;

  try {
    await dockerSock("POST", `/containers/${encodeURIComponent(name)}/stop?t=10`, undefined, 30_000);
  } catch {
    // best-effort — container may already be stopped
  }
  await dockerSock(
    "POST",
    `/containers/${encodeURIComponent(name)}/rename?name=${encodeURIComponent(backupName)}`,
  );

  try {
    const created = (await dockerSock(
      "POST",
      `/containers/create?name=${encodeURIComponent(name)}`,
      createBody,
      20_000,
    )) as { Id: string };
    await dockerSock("POST", `/containers/${created.Id}/start`, undefined, 20_000);
    await dockerSock("DELETE", `/containers/${encodeURIComponent(backupName)}?force=1`).catch(
      () => undefined,
    );
    return { id: created.Id };
  } catch (err) {
    await dockerSock(
      "DELETE",
      `/containers/${encodeURIComponent(name)}?force=1`,
    ).catch(() => undefined);
    await dockerSock(
      "POST",
      `/containers/${encodeURIComponent(backupName)}/rename?name=${encodeURIComponent(name)}`,
    ).catch(() => undefined);
    await dockerSock("POST", `/containers/${encodeURIComponent(name)}/start`).catch(() => undefined);
    throw err;
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
