import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { coreV1, rolloutRestart, MERGE_PATCH_OPTS } from "@/lib/k8s";
import { withRequestContext } from "@/lib/with-request-context";
import { extractK8sError } from "@/lib/errors";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { markRotated, getRotationAge } from "@/lib/db";
import { auditLog } from "@/lib/helpers/audit";
import { inspectContainer, dockerSock } from "@/lib/helpers/docker-sock";
import fs from "fs/promises";
import path from "path";
import { CLUSTER } from "@/lib/cluster-refs";

export const dynamic = "force-dynamic";

const DOCKER_MODE = process.env.CONSOLE_RUNTIME === "docker";
const DOCKER_SECRETS_DIR = path.join(
  process.env.CONSOLE_DATA_DIR ?? "/data",
  ".docker-secrets",
);

// ─── Docker-mode secret checks ────────────────────────────────────────────────
//
// In docker mode there is no K8s cluster. Configured status comes from:
//   "container" — inspect the named container's Env array
//   "env"       — check process.env (value injected at compose startup)
//   "multi-env" — all named process.env keys must be non-empty
//   "file"      — check the file path stored in the named process.env key
//
// For PATCH, values are written to DOCKER_SECRETS_DIR/<key> and the target
// container (if any) is restarted via the docker socket.

type DockerCheck =
  | { kind: "container"; containerName: string; envKey: string }
  | { kind: "env"; envKey: string }
  | { kind: "multi-env"; envKeys: string[] }
  | { kind: "file"; envKey: string };

// containerName must match the upstream VSS blueprint compose service names.
// Verified from refs/video-search-and-summarization compose files:
//   cosmos-reason2-8b  → NGC_API_KEY  (aliased from NGC_CLI_API_KEY at startup)
//   rtvi-vlm           → NVIDIA_API_KEY
//   rtvi-embed         → HF_TOKEN
const DOCKER_CHECK: Record<string, DockerCheck> = {
  "ngc-key":               { kind: "container", containerName: "cosmos-reason2-8b", envKey: "NGC_API_KEY" },
  "nvidia-api-key":        { kind: "container", containerName: "rtvi-vlm",          envKey: "NVIDIA_API_KEY" },
  "huggingface-token":     { kind: "container", containerName: "rtvi-embed",         envKey: "HF_TOKEN" },
  "slack-webhook-url":     { kind: "env",       envKey: "SLACK_WEBHOOK_URL" },
  "console-auth-password": { kind: "env",       envKey: "CONSOLE_PASSWORD" },
  "camera-sim-ssh-key":    { kind: "file",      envKey: "CAMERA_SIM_SSH_KEY_PATH" },
  "aws-creds":             { kind: "multi-env", envKeys: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] },
};

// Container to restart after PATCH in docker mode (if applicable).
const DOCKER_RESTART_CONTAINER: Record<string, string> = {
  "ngc-key":           "cosmos-reason2-8b",
  "nvidia-api-key":    "rtvi-vlm",
  "huggingface-token": "rtvi-embed",
};

// ─── Secret registry ─────────────────────────────────────────────────────────
//
// Each entry maps a UI key (used by /secrets page) to a K8s Secret + one or
// more data keys inside it. Multi-field secrets (AWS) accept a named-fields
// PATCH body; single-field secrets accept `{ value }`.
//
// Keys here MUST match the ones hard-coded in
//   console/src/app/secrets/page.tsx  (SECRET_KEYS)
// so that GET /api/secrets/<key> and the rotate dialog agree.

interface RestartTarget {
  kind: "Deployment" | "StatefulSet";
  namespace: string;
  name: string;
}

interface SecretField {
  /** field in the K8s Secret `data` map */
  dataKey: string;
  /** body key in the multi-field PATCH payload (defaults to `value`) */
  bodyField?: string;
  /** if true, field is optional on PATCH — empty string clears it */
  optional?: boolean;
}

interface SecretSpec {
  namespace: string;
  secretName: string;
  fields: SecretField[];
  /** hash the value with bcrypt before storing (single-field only) */
  bcryptHash?: boolean;
  restartTargets?: RestartTarget[];
  /** If set, "configured" = ANY of these data keys is present (not the default
   *  all-non-optional-fields rule). Lets a secret read as configured whether it
   *  holds the bootstrap plain value or a rotated hash. */
  statusKeys?: string[];
}

// Helm: all VSS secrets live in vss-<profile>.
// Legacy: secrets split across rtvi / alerts namespaces.
const _VSS_NS = CLUSTER.secretsNamespace;
const _legacy = CLUSTER.legacy;

// Resolve namespace: use vss-<profile> under Helm, per-component under legacy.
function vssNs(): string {
  return _VSS_NS ?? "vss-base";
}

const SECRET_REGISTRY: Record<string, SecretSpec> = {
  "ngc-key": {
    namespace: _legacy ? "rtvi" : vssNs(),
    // Helm: NGC_API_KEY lives in the `ngc-api` Secret; `ngc-secret` is the
    // image-pull secret (.dockerconfigjson only).
    secretName: _legacy ? "ngc-secret" : "ngc-api",
    fields: [{ dataKey: "NGC_API_KEY" }],
    restartTargets: _legacy
      ? [
          { kind: "Deployment", namespace: "rtvi", name: "nim-cosmos-reason2" },
          { kind: "Deployment", namespace: "rtvi", name: "nim-preview" },
        ]
      : [
          { kind: "Deployment", namespace: vssNs(), name: "nvidia-nemotron-nano-9b-v2" },
          { kind: "Deployment", namespace: vssNs(), name: "vss-rtvi-vlm" },
        ],
  },
  "nvidia-api-key": {
    namespace: _legacy ? "rtvi" : vssNs(),
    secretName: _legacy ? "nvidia-api-secret" : "ngc-api",
    // Helm `ngc-api` holds NGC_API_KEY / NGC_CLI_API_KEY (no `key` field).
    fields: [{ dataKey: _legacy ? "NVIDIA_API_KEY" : "NGC_API_KEY" }],
    restartTargets: _legacy
      ? [{ kind: "Deployment", namespace: "rtvi", name: "rtvi-vlm" }]
      : [{ kind: "Deployment", namespace: vssNs(), name: "vss-rtvi-vlm" }],
  },
  "huggingface-token": {
    namespace: _legacy ? "rtvi" : vssNs(),
    secretName: _legacy ? "hf-secret" : "ngc-secret",
    fields: [{ dataKey: "HF_TOKEN" }],
    restartTargets: _legacy
      ? [{ kind: "Deployment", namespace: "rtvi", name: "rtvi-embed" }]
      : [{ kind: "Deployment", namespace: vssNs(), name: "vss-rtvi-vlm" }],
  },
  "slack-webhook-url": {
    namespace: _legacy ? "alerts" : vssNs(),
    secretName: _legacy ? "alert-worker-secrets" : "ngc-secret",
    fields: [{ dataKey: "SLACK_WEBHOOK_URL" }],
    restartTargets: _legacy
      ? [{ kind: "Deployment", namespace: "alerts", name: "alert-worker" }]
      : [{ kind: "Deployment", namespace: vssNs(), name: "vss-video-analytics-api" }],
  },
  // Deployed k8s/console/10-secrets.yaml uses plain `CONSOLE_PASSWORD`
  // consumed through `envFrom` → process.env.CONSOLE_PASSWORD, which
  // src/lib/auth.ts checks if CONSOLE_PASSWORD_HASH is not set. We write
  // the bcrypt hash into CONSOLE_PASSWORD_HASH so rotations remain hashed
  // at rest without ever losing the original plain-text bootstrap field.
  "console-auth-password": {
    namespace: "console",
    secretName: "console-auth",
    fields: [{ dataKey: "CONSOLE_PASSWORD_HASH" }],
    // Configured if EITHER the rotated hash OR the bootstrap plain password is
    // present — the deployed secret ships `CONSOLE_PASSWORD`.
    statusKeys: ["CONSOLE_PASSWORD_HASH", "CONSOLE_PASSWORD"],
    bcryptHash: true,
    restartTargets: [
      // Pod reads the secret via envFrom — needs a restart for new hash
      // to take effect.
      { kind: "Deployment", namespace: "console", name: "console" },
    ],
  },
  "camera-sim-ssh-key": {
    namespace: "console",
    secretName: "console-ssh",
    fields: [{ dataKey: "id_ed25519" }],
    restartTargets: [
      { kind: "Deployment", namespace: "console", name: "console" },
    ],
  },
  "aws-creds": {
    namespace: "console",
    secretName: "console-aws",
    fields: [
      { dataKey: "AWS_ACCESS_KEY_ID", bodyField: "accessKeyId" },
      { dataKey: "AWS_SECRET_ACCESS_KEY", bodyField: "secretAccessKey" },
      { dataKey: "AWS_SESSION_TOKEN", bodyField: "sessionToken", optional: true },
      { dataKey: "VSS_INSTANCE_SG_ID", bodyField: "securityGroupId", optional: true },
    ],
    restartTargets: [
      { kind: "Deployment", namespace: "console", name: "console" },
    ],
  },
};

// ─── GET — status only, never leaks secret values ────────────────────────────

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { key } = await params;

  if (!SECRET_REGISTRY[key] && !DOCKER_CHECK[key]) {
    return NextResponse.json(
      { error: `Unknown secret key: ${key}. Allowed keys: ${Object.keys(SECRET_REGISTRY).join(", ")}` },
      { status: 400 }
    );
  }

  const rotationAgeMs = getRotationAge(key);
  let configured = false;

  if (DOCKER_MODE) {
    const check = DOCKER_CHECK[key];
    if (check) {
      try {
        if (check.kind === "container") {
          const inspect = await inspectContainer(check.containerName);
          const val = (inspect?.Config.Env ?? [])
            .find((e) => e.startsWith(`${check.envKey}=`))
            ?.slice(check.envKey.length + 1);
          configured = Boolean(val && val.trim().length > 0 && val !== "NOAPIKEYSET");
        } else if (check.kind === "env") {
          configured = Boolean(process.env[check.envKey]?.trim());
          // Also accept a file-based override written by PATCH
          if (!configured) {
            try {
              const stored = await fs.readFile(path.join(DOCKER_SECRETS_DIR, key), "utf-8");
              configured = stored.trim().length > 0;
            } catch { /* no stored value */ }
          }
        } else if (check.kind === "multi-env") {
          configured = check.envKeys.every((k) => Boolean(process.env[k]?.trim()));
          if (!configured) {
            try {
              const stored = await fs.readFile(path.join(DOCKER_SECRETS_DIR, key), "utf-8");
              configured = stored.trim().length > 0;
            } catch { /* no stored value */ }
          }
        } else if (check.kind === "file") {
          const filePath = process.env[check.envKey];
          if (filePath) {
            try { await fs.access(filePath); configured = true; } catch { /* not found */ }
          }
          if (!configured) {
            try {
              const stored = await fs.readFile(path.join(DOCKER_SECRETS_DIR, key), "utf-8");
              configured = stored.trim().length > 0;
            } catch { /* no stored value */ }
          }
        }
      } catch { /* docker socket unavailable — leave configured=false */ }
    }
    return NextResponse.json({ key, configured, ageMs: rotationAgeMs });
  }

  // ─── K8s mode ─────────────────────────────────────────────────────────────
  const spec = SECRET_REGISTRY[key];
  if (!spec) {
    return NextResponse.json(
      { error: `Secret key ${key} is not supported in k8s mode` },
      { status: 400 }
    );
  }

  let k8sCreatedAtMs: number | null = null;

  try {
    const secret = await coreV1().readNamespacedSecret({
      name: spec.secretName,
      namespace: spec.namespace,
    });
    const data = (secret.data ?? {}) as Record<string, string>;
    const present = (dk: string) => typeof data[dk] === "string" && data[dk].length > 0;
    configured = spec.statusKeys
      ? spec.statusKeys.some(present)
      : spec.fields.filter((f) => !f.optional).every((f) => present(f.dataKey));

    const ct = secret.metadata?.creationTimestamp;
    if (ct) {
      const t = ct instanceof Date ? ct.getTime() : new Date(ct).getTime();
      if (!Number.isNaN(t)) k8sCreatedAtMs = t;
    }
  } catch (err: unknown) {
    const { status, message } = extractK8sError(err);
    if (status !== 404) {
      return NextResponse.json(
        { error: message, k8sCode: status },
        { status: 502 }
      );
    }
  }

  const ageMs =
    rotationAgeMs !== null
      ? rotationAgeMs
      : configured && k8sCreatedAtMs !== null
      ? Date.now() - k8sCreatedAtMs
      : null;

  return NextResponse.json({ key, configured, ageMs });
}

// ─── PATCH — rotate value(s) ─────────────────────────────────────────────────

const SinglePatchSchema = z.object({ value: z.string().min(1) });

export const PATCH = withRequestContext(async function (
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;

  const { key } = await params;

  if (!SECRET_REGISTRY[key] && !DOCKER_CHECK[key]) {
    return NextResponse.json(
      { error: `Unknown secret key: ${key}. Allowed keys: ${Object.keys(SECRET_REGISTRY).join(", ")}` },
      { status: 400 }
    );
  }

  const body: unknown = await req.json().catch(() => null);

  if (DOCKER_MODE) {
    // In docker mode, values can't be injected into running containers — they
    // are written to DOCKER_SECRETS_DIR and the target container is restarted
    // so that it picks up the value on next compose-level recreation.
    const spec = SECRET_REGISTRY[key];
    const isMultiField = spec && spec.fields.length > 1;

    let storeValue: string;
    if (isMultiField) {
      if (typeof body !== "object" || body === null) {
        return NextResponse.json({ error: "Expected JSON object body" }, { status: 400 });
      }
      storeValue = JSON.stringify(body);
    } else {
      const parsed = SinglePatchSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json(
          { error: "Validation failed", issues: parsed.error.issues },
          { status: 400 }
        );
      }
      storeValue = parsed.data.value;
      if (spec?.bcryptHash) {
        const bcryptLib = await import("bcryptjs");
        storeValue = await bcryptLib.hash(storeValue, 12);
      }
    }

    await fs.mkdir(DOCKER_SECRETS_DIR, { recursive: true });
    await fs.writeFile(path.join(DOCKER_SECRETS_DIR, key), storeValue, { mode: 0o600 });

    const restartWarnings: string[] = [];
    const containerName = DOCKER_RESTART_CONTAINER[key];
    if (containerName) {
      try {
        await dockerSock("POST", `/containers/${containerName}/restart?t=10`);
      } catch (err) {
        restartWarnings.push(`Container restart ${containerName} failed: ${String(err)}`);
      }
    }

    markRotated(key);
    await auditLog("secret-rotate", `docker/secret/${key}`, {
      key,
      container: containerName ?? null,
    });

    return NextResponse.json({
      ok: true,
      rotatedAt: new Date().toISOString(),
      note: "Value persisted. Recreate the compose stack to fully apply.",
      warnings: restartWarnings.length ? restartWarnings : undefined,
    });
  }

  // ─── K8s mode ─────────────────────────────────────────────────────────────
  const spec = SECRET_REGISTRY[key];
  if (!spec) {
    return NextResponse.json(
      { error: `Secret key ${key} is not supported in k8s mode` },
      { status: 400 }
    );
  }

  const isMultiField = spec.fields.length > 1;
  const toPatch: Record<string, string> = {};

  if (isMultiField) {
    if (typeof body !== "object" || body === null) {
      return NextResponse.json({ error: "Expected JSON object body" }, { status: 400 });
    }
    const b = body as Record<string, unknown>;
    for (const field of spec.fields) {
      const bodyKey = field.bodyField ?? field.dataKey;
      const raw = b[bodyKey];
      if (raw === undefined || raw === null) {
        if (!field.optional) {
          return NextResponse.json(
            { error: `Missing required field: ${bodyKey}` },
            { status: 400 }
          );
        }
        continue;
      }
      if (typeof raw !== "string") {
        return NextResponse.json(
          { error: `Field ${bodyKey} must be a string` },
          { status: 400 }
        );
      }
      if (!field.optional && raw.trim().length === 0) {
        return NextResponse.json(
          { error: `Field ${bodyKey} cannot be empty` },
          { status: 400 }
        );
      }
      toPatch[field.dataKey] = raw;
    }
  } else {
    const parsed = SinglePatchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", issues: parsed.error.issues },
        { status: 400 }
      );
    }
    let storeValue = parsed.data.value;
    if (spec.bcryptHash) {
      const bcrypt = await import("bcryptjs");
      storeValue = await bcrypt.hash(storeValue, 12);
    }
    toPatch[spec.fields[0].dataKey] = storeValue;
  }

  const encodedData: Record<string, string> = {};
  for (const [k, v] of Object.entries(toPatch)) {
    encodedData[k] = Buffer.from(v).toString("base64");
  }

  try {
    await coreV1().patchNamespacedSecret({
      name: spec.secretName,
      namespace: spec.namespace,
      body: { data: encodedData },
    }, MERGE_PATCH_OPTS);
  } catch (err: unknown) {
    const { status, message } = extractK8sError(err);
    return NextResponse.json(
      { error: message, k8sCode: status },
      { status }
    );
  }

  const restartWarnings: string[] = [];
  for (const target of spec.restartTargets ?? []) {
    try {
      await rolloutRestart(target.kind, target.namespace, target.name);
    } catch (err) {
      restartWarnings.push(`Restart ${target.name} failed: ${String(err)}`);
    }
  }

  markRotated(key);
  await auditLog("secret-rotate", `${spec.namespace}/secret/${spec.secretName}`, {
    key,
    dataKeys: Object.keys(toPatch),
    restartTargets: spec.restartTargets?.map((t) => t.name) ?? [],
  });

  return NextResponse.json({
    ok: true,
    rotatedAt: new Date().toISOString(),
    warnings: restartWarnings.length ? restartWarnings : undefined,
  });
});
