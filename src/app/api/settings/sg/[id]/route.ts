import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listSgEntries, deleteSgEntry } from "@/lib/db";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { revokeSgIngress, sgManagementConfig } from "@/lib/ec2-sg";
import { auditLog } from "@/lib/helpers/audit";
import { createLogger } from "@/lib/logger";
import { withRequestContext } from "@/lib/with-request-context";

const log = createLogger("api/settings/sg/[id]");

export const dynamic = "force-dynamic";

export const DELETE = withRequestContext(async function (
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;

  // 404 rather than 500 — see the POST route: on a deployment that manages no
  // security group this route is not part of the console. Checked before the
  // entry lookup so the answer does not depend on what happens to be stored.
  const cfg = sgManagementConfig();
  if (!cfg) {
    return NextResponse.json(
      { error: "This deployment does not manage a security group" },
      { status: 404 }
    );
  }

  const { id } = await params;

  // Look up the entry in SQLite
  const entries = listSgEntries();
  const entry = entries.find((e) => e.id === id);

  if (!entry) {
    return NextResponse.json({ error: `SG entry ${id} not found` }, { status: 404 });
  }

  // Revoke in AWS SG
  try {
    await revokeSgIngress(cfg, entry.cidr, entry.port);
  } catch (err: unknown) {
    const awsErr = err as { name?: string; message?: string };
    // Ignore "not found" errors — rule may already be gone
    if (awsErr.name !== "InvalidPermission.NotFound") {
      log.error("sg-write aws error", { err });
      return NextResponse.json(
        { error: "AWS rejected the rule (check IAM and SG state)" },
        { status: 502 }
      );
    }
  }

  // Remove from SQLite
  deleteSgEntry(id);

  await auditLog("sg-remove", `sg/${cfg.sgId}/ingress`, {
    cidr: entry.cidr,
    label: entry.label,
    port: entry.port,
  });

  return NextResponse.json({ ok: true, id });
});
