import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { randomUUID } from "crypto";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { listSgEntries, upsertSgEntry } from "@/lib/db";
import { authorizeSgIngress, sgManagementConfig, CONSOLE_INGRESS_PORT } from "@/lib/ec2-sg";
import { auditLog } from "@/lib/helpers/audit";
import { createLogger } from "@/lib/logger";
import { withRequestContext } from "@/lib/with-request-context";

const log = createLogger("api/settings/sg");

export const dynamic = "force-dynamic";

function isValidCidr(cidr: string): boolean {
  const m = cidr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/);
  if (!m) return false;
  const [, a, b, c, d, prefix] = m;
  for (const o of [a, b, c, d]) if (Number(o) > 255) return false;
  if (prefix !== undefined && Number(prefix) > 32) return false;
  return true;
}

// ─── GET — capability probe + whitelist entries ─────────────────────────────────
//
// `available` says whether this deployment manages a security group at all, so
// the /settings panel can be absent rather than present-and-failing. It is a
// 200 with a flag rather than a 404 on purpose: this is the probe, and an error
// status here would leave the page unable to tell a feature that is not part of
// the deployment from a console that is broken.
//
// The stored rows are a display mirror of AWS, so when nothing is managed there
// is nothing they could be a mirror of, and they are withheld.

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!sgManagementConfig()) {
    return NextResponse.json({ available: false, entries: [] });
  }

  return NextResponse.json({ available: true, entries: listSgEntries() });
}

// ─── POST — add a new CIDR entry ───────────────────────────────────────────────

const AddSgEntrySchema = z.object({
  cidr: z
    .string()
    .min(1)
    .refine(isValidCidr, "Must be a valid IPv4 CIDR (e.g., 1.2.3.4/32)"),
  label: z.string().min(1).max(100),
});

export const POST = withRequestContext(async (req: NextRequest) => {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;

  // 404 rather than 500: on a deployment that manages no security group this is
  // not a misconfiguration to be fixed, it is a route that is not part of the
  // console. Resolved before the body is parsed so a request that cannot
  // succeed is not reported as a validation problem.
  const cfg = sgManagementConfig();
  if (!cfg) {
    return NextResponse.json(
      { error: "This deployment does not manage a security group" },
      { status: 404 }
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = AddSgEntrySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", issues: parsed.error.issues }, { status: 400 });
  }

  const { cidr, label } = parsed.data;
  const operator = session.user?.name ?? session.user?.email ?? "unknown";

  // Authorize in AWS SG
  try {
    await authorizeSgIngress(cfg, cidr, CONSOLE_INGRESS_PORT);
  } catch (err: unknown) {
    const awsErr = err as { name?: string; message?: string };
    // Ignore "already exists" errors
    if (awsErr.name !== "InvalidPermission.Duplicate") {
      log.error("sg-write aws error", { err });
      return NextResponse.json(
        { error: "AWS rejected the rule (check IAM and SG state)" },
        { status: 502 }
      );
    }
  }

  // Persist in SQLite
  const entry = {
    id: randomUUID(),
    cidr,
    label,
    addedBy: operator,
    addedAt: new Date().toISOString(),
    port: CONSOLE_INGRESS_PORT,
  };

  upsertSgEntry(entry);

  await auditLog("sg-add", `sg/${cfg.sgId}/ingress`, {
    cidr,
    label,
    port: CONSOLE_INGRESS_PORT,
  });

  return NextResponse.json({ ok: true, entry });
});
