import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ModelCardSchema } from "@/lib/schemas";
import modelCatalog from "@/data/model-catalog.json";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Validate catalog at runtime so schema mismatches surface early
  const parsed = modelCatalog.map((m, i) => {
    const result = ModelCardSchema.safeParse(m);
    if (!result.success) {
      console.warn(`[models] catalog entry ${i} invalid:`, result.error.issues);
      return null;
    }
    return result.data;
  }).filter(Boolean);

  return NextResponse.json({ models: parsed });
}
