import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { coreV1, rolloutRestart } from "@/lib/k8s";
import { markRotated } from "@/lib/db";
import { auditLog } from "@/lib/helpers/audit";

export const dynamic = "force-dynamic";

interface SecretSpec {
  namespace: string;
  secretName: string;
  dataKey: string;
  restartTargets?: Array<{ kind: "Deployment" | "StatefulSet"; namespace: string; name: string }>;
}

const SECRET_WHITELIST: Record<string, SecretSpec> = {
  "ngc-key": {
    namespace: "rtvi",
    secretName: "ngc-secret",
    dataKey: "NGC_API_KEY",
    restartTargets: [
      { kind: "Deployment", namespace: "rtvi", name: "nim-cosmos-reason2" },
      { kind: "Deployment", namespace: "rtvi", name: "nim-preview" },
    ],
  },
  "nvidia-api-key": {
    namespace: "rtvi",
    secretName: "nvidia-api-secret",
    dataKey: "NVIDIA_API_KEY",
    restartTargets: [
      { kind: "Deployment", namespace: "rtvi", name: "rtvi-vlm" },
    ],
  },
  "hf-token": {
    namespace: "rtvi",
    secretName: "hf-secret",
    dataKey: "HF_TOKEN",
    restartTargets: [
      { kind: "Deployment", namespace: "rtvi", name: "rtvi-embed" },
    ],
  },
  "slack-webhook": {
    namespace: "alerts",
    secretName: "alert-worker-secrets",
    dataKey: "SLACK_WEBHOOK_URL",
    restartTargets: [
      { kind: "Deployment", namespace: "alerts", name: "alert-worker" },
    ],
  },
  "console-password": {
    namespace: "console",
    secretName: "console-auth",
    dataKey: "CONSOLE_PASSWORD_HASH",
    restartTargets: [], // console restarts itself via next-auth session invalidation
  },
};

const PatchSecretSchema = z.object({
  value: z.string().min(1),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { key } = await params;
  const spec = SECRET_WHITELIST[key];

  if (!spec) {
    return NextResponse.json(
      {
        error: `Unknown secret key: ${key}. Allowed keys: ${Object.keys(SECRET_WHITELIST).join(", ")}`,
      },
      { status: 400 }
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = PatchSecretSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", issues: parsed.error.issues }, { status: 400 });
  }

  const { value } = parsed.data;

  // For console-password, bcrypt-hash the value before storing
  let storeValue = value;
  if (key === "console-password") {
    const bcrypt = await import("bcryptjs");
    storeValue = await bcrypt.hash(value, 12);
  }

  // Patch the K8s Secret — base64 encode the value
  const encodedValue = Buffer.from(storeValue).toString("base64");
  try {
    await coreV1().patchNamespacedSecret({
      name: spec.secretName,
      namespace: spec.namespace,
      body: {
        data: { [spec.dataKey]: encodedValue },
      },
    });
  } catch (err: unknown) {
    const k8sErr = err as { statusCode?: number; body?: { message?: string } };
    return NextResponse.json(
      { error: k8sErr.body?.message ?? String(err), k8sCode: k8sErr.statusCode },
      { status: k8sErr.statusCode ?? 502 }
    );
  }

  // Rollout-restart consuming Deployments
  const restartWarnings: string[] = [];
  for (const target of spec.restartTargets ?? []) {
    try {
      await rolloutRestart(target.kind, target.namespace, target.name);
    } catch (err) {
      restartWarnings.push(`Restart ${target.name} failed: ${String(err)}`);
    }
  }

  // Record rotation timestamp
  markRotated(key);

  await auditLog("secret-rotate", `${spec.namespace}/secret/${spec.secretName}`, {
    key,
    dataKey: spec.dataKey,
    restartTargets: spec.restartTargets?.map((t) => t.name) ?? [],
  });

  return NextResponse.json({
    ok: true,
    rotatedAt: new Date().toISOString(),
    warnings: restartWarnings.length ? restartWarnings : undefined,
  });
}
