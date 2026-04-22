import "server-only";
import { appendAuditLog } from "../db";
import { auth } from "../auth";

/**
 * Append an audit log entry, resolving the operator name from the current
 * next-auth session.  Falls back to "unknown" when called outside an
 * authenticated context (should not happen in production).
 */
export async function auditLog(
  action: string,
  target: string,
  details: Record<string, unknown>
): Promise<void> {
  const session = await auth();
  const operator = session?.user?.name ?? session?.user?.email ?? "unknown";

  await appendAuditLog({
    operator,
    action,
    target,
    detailsJson: JSON.stringify(details),
  });
}

/**
 * Synchronous version for use where we already have the operator string
 * (avoids a second async session lookup inside the same request handler).
 */
export async function auditLogAs(
  operator: string,
  action: string,
  target: string,
  details: Record<string, unknown>
): Promise<void> {
  await appendAuditLog({
    operator,
    action,
    target,
    detailsJson: JSON.stringify(details),
  });
}
