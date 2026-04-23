import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { coreV1, rolloutRestart } from "@/lib/k8s";
import { markRotated, getRotationAge } from "@/lib/db";
import { auditLog } from "@/lib/helpers/audit";

export const dynamic = "force-dynamic";

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
}

const SECRET_REGISTRY: Record<string, SecretSpec> = {
  "ngc-key": {
    namespace: "rtvi",
    secretName: "ngc-secret",
    fields: [{ dataKey: "NGC_API_KEY" }],
    restartTargets: [
      { kind: "Deployment", namespace: "rtvi", name: "nim-cosmos-reason2" },
      { kind: "Deployment", namespace: "rtvi", name: "nim-preview" },
    ],
  },
  "nvidia-api-key": {
    namespace: "rtvi",
    secretName: "nvidia-api-secret",
    fields: [{ dataKey: "NVIDIA_API_KEY" }],
    restartTargets: [
      { kind: "Deployment", namespace: "rtvi", name: "rtvi-vlm" },
    ],
  },
  "huggingface-token": {
    namespace: "rtvi",
    secretName: "hf-secret",
    fields: [{ dataKey: "HF_TOKEN" }],
    restartTargets: [
      { kind: "Deployment", namespace: "rtvi", name: "rtvi-embed" },
    ],
  },
  "slack-webhook-url": {
    namespace: "alerts",
    secretName: "alert-worker-secrets",
    fields: [{ dataKey: "SLACK_WEBHOOK_URL" }],
    restartTargets: [
      { kind: "Deployment", namespace: "alerts", name: "alert-worker" },
    ],
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
  const spec = SECRET_REGISTRY[key];

  if (!spec) {
    return NextResponse.json(
      {
        error: `Unknown secret key: ${key}. Allowed keys: ${Object.keys(SECRET_REGISTRY).join(", ")}`,
      },
      { status: 400 }
    );
  }

  let configured = false;
  let k8sCreatedAtMs: number | null = null;

  try {
    const secret = await coreV1().readNamespacedSecret({
      name: spec.secretName,
      namespace: spec.namespace,
    });
    const data = (secret.data ?? {}) as Record<string, string>;
    // For multi-field secrets, "configured" = all REQUIRED fields non-empty.
    // For single-field, "configured" = the single dataKey is non-empty.
    configured = spec.fields
      .filter((f) => !f.optional)
      .every((f) => typeof data[f.dataKey] === "string" && data[f.dataKey].length > 0);

    const ct = secret.metadata?.creationTimestamp;
    if (ct) {
      const t = ct instanceof Date ? ct.getTime() : new Date(ct).getTime();
      if (!Number.isNaN(t)) k8sCreatedAtMs = t;
    }
  } catch (err: unknown) {
    const k8sErr = err as { statusCode?: number; body?: { message?: string } };
    // 404 = secret not yet applied → not configured. Any other error is a
    // genuine failure we want to surface.
    if (k8sErr.statusCode !== 404) {
      return NextResponse.json(
        { error: k8sErr.body?.message ?? String(err), k8sCode: k8sErr.statusCode },
        { status: 502 }
      );
    }
  }

  // Age: prefer the last rotation recorded in the console DB (set by PATCH);
  // fall back to the K8s Secret's creationTimestamp so the UI still shows
  // "last rotated N days ago" for a fresh install that hasn't been rotated.
  const rotationAgeMs = getRotationAge(key);
  const ageMs =
    rotationAgeMs !== null
      ? rotationAgeMs
      : configured && k8sCreatedAtMs !== null
      ? Date.now() - k8sCreatedAtMs
      : null;

  return NextResponse.json({
    key,
    configured,
    ageMs,
  });
}

// ─── PATCH — rotate value(s) ─────────────────────────────────────────────────

const SinglePatchSchema = z.object({ value: z.string().min(1) });

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { key } = await params;
  const spec = SECRET_REGISTRY[key];

  if (!spec) {
    return NextResponse.json(
      {
        error: `Unknown secret key: ${key}. Allowed keys: ${Object.keys(SECRET_REGISTRY).join(", ")}`,
      },
      { status: 400 }
    );
  }

  const body: unknown = await req.json().catch(() => null);
  const isMultiField = spec.fields.length > 1;

  // Build { [dataKey]: <plaintext string> } for every field we're updating.
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

  // K8s Secret `data` is base64-encoded.
  const encodedData: Record<string, string> = {};
  for (const [k, v] of Object.entries(toPatch)) {
    encodedData[k] = Buffer.from(v).toString("base64");
  }

  try {
    await coreV1().patchNamespacedSecret({
      name: spec.secretName,
      namespace: spec.namespace,
      body: { data: encodedData },
    });
  } catch (err: unknown) {
    const k8sErr = err as { statusCode?: number; body?: { message?: string } };
    return NextResponse.json(
      { error: k8sErr.body?.message ?? String(err), k8sCode: k8sErr.statusCode },
      { status: k8sErr.statusCode ?? 502 }
    );
  }

  // Rollout-restart consuming Deployments / StatefulSets.
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
}
