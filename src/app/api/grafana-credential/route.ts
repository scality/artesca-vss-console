import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { CLUSTER } from "@/lib/cluster-refs";
import { auditLog } from "@/lib/helpers/audit";
import { withRequestContext } from "@/lib/with-request-context";

/**
 * Serves the Grafana password to an operator who explicitly asks for it, and
 * records that they did.
 *
 * The overview used to render the value straight into the page. That is not a
 * masking problem — `src/app/page.tsx` is a server component, so the password
 * travelled in the HTML payload of every dashboard load, for every viewer, and
 * a CSS mask over it would have hidden it from the operator while leaving it in
 * "view source". Removing it from the payload is the fix; this route is how the
 * operator still gets it (ISVD-550).
 *
 * **POST, not GET, and that is load-bearing.** The response is a credential and
 * the call has a side effect. A GET would be fetched by a link prefetch, a
 * crawler or a browser's address-bar speculation, each of which would serve the
 * password and write an audit entry naming an operator who never asked.
 */
export const POST = withRequestContext(async () => {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // The showroom display runs in kiosk mode. It must never be able to reveal a
  // credential — the whole point of that mode is an unattended screen.
  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;

  const password = CLUSTER.grafana.password;
  if (!password) {
    return NextResponse.json({ error: "GRAFANA_PASSWORD is not configured" }, { status: 404 });
  }

  // Audited before the value is returned, so a response that reaches the client
  // is a response that was recorded. The entry names the operator and the fact;
  // it deliberately does not carry the value.
  await auditLog("reveal", "grafana-password", { url: CLUSTER.grafana.url });

  return NextResponse.json(
    { password },
    // A credential must not sit in a shared cache or a disk cache.
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
});
