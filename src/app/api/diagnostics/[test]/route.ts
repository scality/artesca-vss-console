import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { coreV1, watchedNamespaces } from "@/lib/k8s";
import { sshExec } from "@/lib/ssh";
import { auditLog } from "@/lib/helpers/audit";
import { withRequestContext } from "@/lib/with-request-context";

export const dynamic = "force-dynamic";


type DiagnosticSpec =
  | { via: "k8s-api-events" }
  | { via: "k8s-api-nodes" }
  | { via: "ssh"; command: string }
  | { via: "ssh-nvidia-smi" };

const DIAGNOSTICS: Record<string, DiagnosticSpec> = {
  "validate-manifests": {
    via: "ssh",
    command: "bash /opt/console/scripts/validate-manifests.sh 2>&1",
  },
  "phase-smoke-1": {
    via: "ssh",
    command: "bash /opt/console/scripts/phase-1-smoke-test.sh 2>&1",
  },
  "phase-smoke-2": {
    via: "ssh",
    command: "bash /opt/console/scripts/phase-2-smoke-test.sh 2>&1",
  },
  "phase-smoke-3": {
    via: "ssh",
    command: "bash /opt/console/scripts/phase-3-smoke-test.sh 2>&1",
  },
  "phase-smoke-4": {
    via: "ssh",
    command: "bash /opt/console/scripts/phase-4-smoke-test.sh 2>&1",
  },
  "phase-smoke-5": {
    via: "ssh",
    command: "bash /opt/console/scripts/phase-5-smoke-test.sh 2>&1",
  },
  "get-events": { via: "k8s-api-events" },
  "nvidia-smi": { via: "ssh-nvidia-smi" },
  "kubectl-top": { via: "k8s-api-nodes" },
};

export const POST = withRequestContext(async function (
  _req: Request,
  { params }: { params: Promise<{ test: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { test } = await params;
  const spec = DIAGNOSTICS[test];

  if (!spec) {
    return NextResponse.json(
      {
        error: `Unknown test: ${test}. Available: ${Object.keys(DIAGNOSTICS).join(", ")}`,
      },
      { status: 400 }
    );
  }

  const startedAt = new Date().toISOString();
  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  try {
    if (spec.via === "ssh") {
      const result = await sshExec(spec.command);
      stdout = result.stdout;
      stderr = result.stderr;
      exitCode = result.code;
    } else if (spec.via === "ssh-nvidia-smi") {
      // Run nvidia-smi on the ARTESCA node via SSH
      const result = await sshExec("nvidia-smi 2>&1");
      stdout = result.stdout;
      stderr = result.stderr;
      exitCode = result.code;
    } else if (spec.via === "k8s-api-events") {
      const namespaces = [...watchedNamespaces(), "console"];
      const eventLines: string[] = [];
      for (const ns of namespaces) {
        try {
          const evList = await coreV1().listNamespacedEvent({ namespace: ns });
          for (const ev of evList.items) {
            const reason = ev.reason ?? "";
            const msg = ev.message ?? "";
            const component = ev.involvedObject?.name ?? "";
            const count = ev.count ?? 1;
            const time = ev.lastTimestamp ?? "";
            eventLines.push(
              `[${ns}] ${String(time).slice(0, 19)} ${component} ${reason} (x${count}): ${msg}`
            );
          }
        } catch {
          eventLines.push(`[${ns}] Failed to list events`);
        }
      }
      stdout = eventLines.sort().join("\n");
      exitCode = 0;
    } else if (spec.via === "k8s-api-nodes") {
      const nodeList = await coreV1().listNode();
      const lines = nodeList.items.map((n) => {
        const name = n.metadata?.name ?? "?";
        const capacity = n.status?.capacity ?? {};
        const allocatable = n.status?.allocatable ?? {};
        return (
          `${name}  cpu=${allocatable["cpu"] ?? capacity["cpu"] ?? "?"}` +
          `  memory=${allocatable["memory"] ?? capacity["memory"] ?? "?"}` +
          `  gpu=${capacity["nvidia.com/gpu"] ?? "0"}`
        );
      });
      stdout = ["NAME  CPU  MEMORY  GPU", ...lines].join("\n");
      exitCode = 0;
    }
  } catch (err) {
    stderr = String(err);
    exitCode = 1;
  }

  await auditLog("diagnostic-run", `diagnostic/${test}`, {
    test,
    exitCode,
    stdoutLength: stdout.length,
  });

  return NextResponse.json({ test, startedAt, exitCode, stdout, stderr });
});
