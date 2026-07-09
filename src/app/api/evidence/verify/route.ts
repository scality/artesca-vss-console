/**
 * POST /api/evidence/verify  → { key, versionId? }
 *
 * Proof-of-immutability: attempts to permanently delete the locked version and
 * reports whether ARTESCA denied it. { denied: true } means the WORM lock held.
 */
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { withRequestContext } from "@/lib/with-request-context";
import { verifyImmutable } from "@/lib/evidence";

export const dynamic = "force-dynamic";

const VerifySchema = z.object({
  key: z.string().min(1).max(500),
  versionId: z.string().max(200).optional(),
});

export const POST = withRequestContext(async function (req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = VerifySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  return NextResponse.json(await verifyImmutable(parsed.data.key, parsed.data.versionId));
});
