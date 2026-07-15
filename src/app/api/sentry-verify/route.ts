export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Deliberate unhandled error for verifying the Sentry pipeline end to end
 * (event delivery + readable stack frames after source-map upload). The
 * console pod is reachable only over the SG-restricted :8800 hostPort, so
 * this route is not publicly exposed.
 */
export async function GET() {
  throw new Error("sentry-verify: deliberate test error");
}
