import "server-only";

import { promises as fs } from "fs";
import { hostname } from "os";
import path from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type {
  ConfigStore,
  CameraEntry,
  ReconcileStatus,
  PromptDoc,
  PromptSet,
  ScenarioEntry,
} from "@/lib/config-store/types";

export const CONFIG_SCHEMA = "isv-labs.console-config.v1";

/**
 * One instance's entire stored configuration, as it appears on disk.
 *
 * One file per instance, holding every entity kind, rather than a file each: an
 * operator reads, diffs, copies or hands over an instance's configuration as a
 * single artifact, which is the property a directory of six files does not have.
 * The cost is that every write is a read-modify-write on one file, so the
 * locking below is load-bearing rather than defensive.
 */
export interface ConfigDoc {
  schema: string;
  instance: string;
  updatedAt?: string;
  updatedBy?: string;
  /** Active prompt-set id. Absent = no set bound; the legacy `prompt` is used. */
  activePromptId?: string;
  /** Legacy single prompt, superseded by prompt-sets but still read. */
  prompt?: Record<string, unknown>;
  reconcileStatus?: ReconcileStatus;
  cameras: Record<string, unknown>[];
  scenarios: Record<string, unknown>[];
  promptSets: Record<string, unknown>[];
}

export class ConfigFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigFileError";
  }
}

/**
 * The instance name becomes a filename, so it is checked rather than trusted.
 * `VSS_INSTANCE_NAME` comes from the deployment today, but the same value also
 * arrives on request paths, and `../../etc/passwd` resolving out of the data
 * directory is not a failure anyone would see in a log.
 */
const SAFE_INSTANCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertSafeInstance(instance: string): void {
  if (!SAFE_INSTANCE.test(instance) || instance.includes("..")) {
    throw new ConfigFileError(
      `invalid instance name ${JSON.stringify(instance)}: expected letters, digits, dot, dash ` +
        `or underscore (max 128, no leading punctuation, no "..")`,
    );
  }
}

/** Where the per-instance files live. `/data` is the console's PVC mount. */
export function configDir(): string {
  const dir = process.env.CONSOLE_DATA_DIR?.trim() || "/data";
  return path.join(dir, "config-store");
}

export function configFilePath(instance: string, dir = configDir()): string {
  assertSafeInstance(instance);
  return path.join(dir, `${instance}.yaml`);
}

function emptyDoc(instance: string): ConfigDoc {
  return { schema: CONFIG_SCHEMA, instance, cameras: [], scenarios: [], promptSets: [] };
}

/**
 * Structural validation of a parsed file.
 *
 * Deliberately checks shape and not membership: an entity list must be a list of
 * objects carrying a string `id`, and unknown fields pass through untouched.
 * Firestore stamps `updatedBy`/`updatedAt` onto each entity and reads them back
 * out, and a newer console will store fields this one has never heard of — a
 * validator that rejected those would turn a forward-compatible file into a
 * hard read failure on the older pod.
 */
function validateDoc(raw: unknown, instance: string, where: string): ConfigDoc {
  if (raw === null || raw === undefined) return emptyDoc(instance);
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigFileError(`${where}: expected a YAML mapping, got ${Array.isArray(raw) ? "a list" : typeof raw}`);
  }
  const doc = raw as Record<string, unknown>;

  const list = (key: "cameras" | "scenarios" | "promptSets"): Record<string, unknown>[] => {
    const v = doc[key];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new ConfigFileError(`${where}: "${key}" must be a list, got ${typeof v}`);
    return v.map((entry, i) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new ConfigFileError(`${where}: ${key}[${i}] must be a mapping`);
      }
      const e = entry as Record<string, unknown>;
      if (typeof e.id !== "string" || !e.id) {
        throw new ConfigFileError(`${where}: ${key}[${i}] has no string "id"`);
      }
      return e;
    });
  };

  // A file that parses as YAML but is some other document entirely is a
  // configuration mistake worth naming, not something to read as "no cameras".
  if (doc.schema !== undefined && doc.schema !== CONFIG_SCHEMA) {
    throw new ConfigFileError(
      `${where}: unknown schema ${JSON.stringify(doc.schema)} (expected ${CONFIG_SCHEMA})`,
    );
  }

  return {
    schema: CONFIG_SCHEMA,
    instance: typeof doc.instance === "string" && doc.instance ? doc.instance : instance,
    ...(typeof doc.updatedAt === "string" ? { updatedAt: doc.updatedAt } : {}),
    ...(typeof doc.updatedBy === "string" ? { updatedBy: doc.updatedBy } : {}),
    ...(typeof doc.activePromptId === "string" ? { activePromptId: doc.activePromptId } : {}),
    ...(doc.prompt && typeof doc.prompt === "object" && !Array.isArray(doc.prompt)
      ? { prompt: doc.prompt as Record<string, unknown> }
      : {}),
    ...(doc.reconcileStatus && typeof doc.reconcileStatus === "object" && !Array.isArray(doc.reconcileStatus)
      ? { reconcileStatus: doc.reconcileStatus as unknown as ReconcileStatus }
      : {}),
    cameras: list("cameras"),
    scenarios: list("scenarios"),
    promptSets: list("promptSets"),
  };
}

// ─── Cross-process locking ────────────────────────────────────────────────────
//
// Two pods write this store. The console pod serves the UI (camera upserts,
// prompt-set edits, scenario writes) and the `reconcile-agent` pod writes a
// `reconcileStatus` on every tick plus a one-shot prompt-set seed at boot — and
// the console additionally fires one startup convergence pass of its own, so
// even a deployment with `RECONCILE_LOOP_DISABLED` has two writers rather than
// one. Every write here is a read-modify-write of one file, so without a lock
// the agent's status write and an operator's camera edit are a lost update, and
// the loser is whichever finished first.
//
// An in-process mutex would not reach across pods. The lock is therefore a file
// beside the data, created with O_CREAT|O_EXCL — atomic on the shared volume
// both pods mount.

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 50;

/** Per-path in-process queue, so same-process writers wait on a promise instead
 *  of spinning on the lock file. The cross-process lock is still what makes the
 *  write safe; this only keeps the common case off the retry path. */
const queues = new Map<string, Promise<unknown>>();

async function acquire(lockPath: string): Promise<void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fh = await fs.open(lockPath, "wx");
      await fh.writeFile(`${process.pid}@${hostname()} ${new Date().toISOString()}\n`);
      await fh.close();
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // A pod killed mid-write leaves the file behind. Reclaim it by age rather
      // than by pid: the holder is in another container and its pids mean
      // nothing here.
      try {
        const st = await fs.stat(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
      } catch {
        continue; // vanished between EEXIST and stat — try to take it
      }
      if (Date.now() > deadline) {
        throw new ConfigFileError(
          `timed out after ${LOCK_TIMEOUT_MS}ms waiting for ${lockPath}; another writer is holding it`,
        );
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
}

async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${file}.lock`;
  const run = async (): Promise<T> => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await acquire(lockPath);
    try {
      return await fn();
    } finally {
      await fs.rm(lockPath, { force: true }).catch(() => {});
    }
  };
  // Chain onto whatever this process already has queued for the same file. The
  // stored promise is the swallowed one: a failed write must not reject the next
  // writer's turn, only its own caller.
  const prior = queues.get(file) ?? Promise.resolve();
  const result = prior.then(run, run);
  const turn = result.then(
    () => {},
    () => {},
  );
  queues.set(file, turn);
  // Drop the entry once this is the last turn, so a long-lived process holding
  // many instances does not accumulate one settled promise per file forever.
  void turn.then(() => {
    if (queues.get(file) === turn) queues.delete(file);
  });
  return result;
}

/** Write the whole document atomically: a reader either sees the previous file
 *  or the new one, never a half-written mapping. */
async function writeDocAtomic(file: string, doc: ConfigDoc): Promise<void> {
  const tmp = `${file}.tmp.${process.pid}`;
  const body = stringifyYaml(doc, { lineWidth: 0 });
  await fs.writeFile(tmp, body, { mode: 0o640 });
  await fs.rename(tmp, file);
}

// ─── The store ────────────────────────────────────────────────────────────────

const stamp = (updatedBy: string) => ({ updatedBy, updatedAt: new Date().toISOString() });

/**
 * YAML-file-backed ConfigStore — the default backend.
 *
 * Semantics match the Firestore store exactly, and one of them is easy to get
 * wrong: **`upsert` replaces the whole entity, it does not merge fields.**
 * Firestore's `set()` without `{merge:true}` overwrites the document, and the
 * camera PATCH route relies on it — unbinding a prompt or clearing a scenario
 * override is expressed by `delete`ing the key from the object it then upserts.
 * A field merge would silently keep the old value and make "unbind" a no-op,
 * and `scenarioIds` would additionally lose its third state: absent means the
 * scenario's own `sensor_filter` glob decides, `[]` means suppress everything.
 */
export class FileConfigStore implements ConfigStore {
  constructor(private readonly dir: string = configDir()) {}

  private file(instance: string): string {
    return configFilePath(instance, this.dir);
  }

  /** Read the document. A missing file is an empty instance — the same answer
   *  Firestore gives for an instance with no documents yet. A file that exists
   *  and does not parse is an error: reading it as empty would present a
   *  configured instance as a blank one, and the reconciler would then converge
   *  the cluster onto nothing. */
  async read(instance: string): Promise<ConfigDoc> {
    const file = this.file(instance);
    let body: string;
    try {
      body = await fs.readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyDoc(instance);
      throw err;
    }
    let raw: unknown;
    try {
      raw = parseYaml(body);
    } catch (err) {
      throw new ConfigFileError(
        `${file} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return validateDoc(raw, instance, file);
  }

  /** Read-modify-write under the cross-process lock. */
  private async mutate(instance: string, updatedBy: string, fn: (doc: ConfigDoc) => void): Promise<void> {
    const file = this.file(instance);
    await withFileLock(file, async () => {
      const doc = await this.read(instance);
      fn(doc);
      doc.updatedBy = updatedBy;
      doc.updatedAt = new Date().toISOString();
      await writeDocAtomic(file, doc);
    });
  }

  async readCameras(instance: string): Promise<CameraEntry[]> {
    return (await this.read(instance)).cameras as unknown as CameraEntry[];
  }

  async writeCameras(instance: string, cameras: CameraEntry[], updatedBy: string): Promise<void> {
    const s = stamp(updatedBy);
    await this.mutate(instance, updatedBy, (doc) => {
      doc.cameras = cameras.map((c) => ({ ...c, ...s }));
    });
  }

  async upsertCamera(instance: string, camera: CameraEntry, updatedBy: string): Promise<void> {
    await this.mutate(instance, updatedBy, (doc) => {
      // Whole-entity replace, not a field merge — see the class comment.
      const next = { ...camera, ...stamp(updatedBy) };
      const i = doc.cameras.findIndex((c) => c.id === camera.id);
      if (i === -1) doc.cameras.push(next);
      else doc.cameras[i] = next;
    });
  }

  async deleteCamera(instance: string, id: string, updatedBy: string): Promise<void> {
    await this.mutate(instance, updatedBy, (doc) => {
      doc.cameras = doc.cameras.filter((c) => c.id !== id);
    });
  }

  async readStatus(instance: string): Promise<ReconcileStatus | null> {
    return (await this.read(instance)).reconcileStatus ?? null;
  }

  async writeStatus(instance: string, status: ReconcileStatus): Promise<void> {
    // Firestore stamps no updatedBy here (writeStatus takes none); the agent
    // version inside the status is who wrote it.
    await this.mutate(instance, status.agentVersion, (doc) => {
      doc.reconcileStatus = status;
    });
  }

  async readPrompt(instance: string): Promise<PromptDoc | null> {
    const doc = await this.read(instance);
    if (doc.activePromptId) {
      const active = doc.promptSets.find((s) => s.id === doc.activePromptId);
      if (active && typeof active.text === "string") {
        return {
          prompt: active.text,
          ...(typeof active.model === "string" ? { model: active.model } : {}),
        };
      }
    }
    const raw = doc.prompt;
    if (!raw || typeof raw.prompt !== "string") return null;
    const out: PromptDoc = { prompt: raw.prompt };
    if (typeof raw.model === "string") out.model = raw.model;
    return out;
  }

  async writePrompt(instance: string, prompt: PromptDoc, updatedBy: string): Promise<void> {
    await this.mutate(instance, updatedBy, (doc) => {
      doc.prompt = {
        prompt: prompt.prompt,
        ...(prompt.model ? { model: prompt.model } : {}),
        ...stamp(updatedBy),
      };
    });
  }

  async readScenarios(instance: string): Promise<ScenarioEntry[]> {
    return (await this.read(instance)).scenarios as unknown as ScenarioEntry[];
  }

  async writeScenarios(instance: string, scenarios: ScenarioEntry[], updatedBy: string): Promise<void> {
    const s = stamp(updatedBy);
    await this.mutate(instance, updatedBy, (doc) => {
      doc.scenarios = scenarios.map((x) => ({ ...x, ...s }));
    });
  }

  async readPromptSets(instance: string): Promise<PromptSet[]> {
    return (await this.read(instance)).promptSets as unknown as PromptSet[];
  }

  async upsertPromptSet(instance: string, set: PromptSet, updatedBy: string): Promise<void> {
    await this.mutate(instance, updatedBy, (doc) => {
      const next = { ...set, ...stamp(updatedBy) };
      const i = doc.promptSets.findIndex((s) => s.id === set.id);
      if (i === -1) doc.promptSets.push(next);
      else doc.promptSets[i] = next;
    });
  }

  async deletePromptSet(instance: string, id: string, updatedBy: string): Promise<void> {
    await this.mutate(instance, updatedBy, (doc) => {
      doc.promptSets = doc.promptSets.filter((s) => s.id !== id);
    });
  }

  async readActivePromptId(instance: string): Promise<string | null> {
    return (await this.read(instance)).activePromptId ?? null;
  }

  async setActivePromptId(instance: string, id: string, updatedBy: string): Promise<void> {
    await this.mutate(instance, updatedBy, (doc) => {
      doc.activePromptId = id;
    });
  }
}

export interface FileStoreHealthResult {
  status: "ok" | "error";
  detail?: string;
  dir: string;
  file?: string;
  /** Absent when the instance has no file yet — a fresh instance, not a fault. */
  counts?: { promptSets: number; cameras: number; scenarios: number };
}

/**
 * Reachability + content probe, mirroring `firestoreHealthCheck`. Never throws.
 *
 * A missing file reports `ok` with zero counts: the store is writable and the
 * instance simply has nothing yet. An unwritable directory is an error, and it
 * is the one worth catching — the PVC not being mounted looks exactly like an
 * empty instance until the first write fails.
 */
export async function fileStoreHealthCheck(
  instance: string,
  dir = configDir(),
): Promise<FileStoreHealthResult> {
  if (!instance) return { status: "error", detail: "VSS_INSTANCE_NAME not set", dir };
  try {
    assertSafeInstance(instance);
    await fs.mkdir(dir, { recursive: true });
    await fs.access(dir, (await import("fs")).constants.W_OK);
    const store = new FileConfigStore(dir);
    const doc = await store.read(instance);
    return {
      status: "ok",
      dir,
      file: configFilePath(instance, dir),
      counts: {
        promptSets: doc.promptSets.length,
        cameras: doc.cameras.length,
        scenarios: doc.scenarios.length,
      },
    };
  } catch (err) {
    return {
      status: "error",
      detail: err instanceof Error ? err.message.slice(0, 300) : String(err),
      dir,
    };
  }
}
