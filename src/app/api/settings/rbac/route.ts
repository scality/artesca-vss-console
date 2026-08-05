import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { CLUSTER } from "@/lib/cluster-refs";

export const dynamic = "force-dynamic";

// Reference RBAC summary for the console ServiceAccount, mirroring
// k8s/console/01-rbac.yaml. The namespaced-roles list depends on the deploy
// layout (VSS_NAMESPACE / CONSOLE_LEGACY_NAMESPACES) — both server-only env, so
// this route resolves them via CLUSTER and hands the client the real values.
// (RbacInspector renders an env-independent placeholder until this responds, to
// avoid an SSR/client hydration mismatch on the namespace name.)
export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const namespacedRoles = CLUSTER.legacy
    ? ["vst", "rtvi", "agent", "alerts", "pyramid-ingress"]
    : [CLUSTER.vssNamespace, "pyramid-ingress"];

  return NextResponse.json({
    serviceAccount: "console",
    namespace: "console",
    clusterRoles: ["console-reader"],
    namespacedRoles: namespacedRoles.map((namespace) => ({
      namespace,
      role: "console-writer",
    })),
  });
}
