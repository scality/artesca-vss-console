import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { gcsPromptPut, type PromptConfig } from "@/lib/helpers/gcs-config";
import { readPromptLive } from "@/lib/helpers/prompt-apply";

export const dynamic = "force-dynamic";

const DOCKER_MODE = process.env.CONSOLE_RUNTIME === "docker";
const VSS_INSTANCE_NAME = process.env.VSS_INSTANCE_NAME ?? "";

// ─── POST /api/prompt/sync-gcs ────────────────────────────────────────────────
//
// Snapshots the current live VLM prompt to GCS.
// Used by the "Save to GCS" button on the prompt page.

export async function POST() {
  const session = await auth();
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!VSS_INSTANCE_NAME) {
    return NextResponse.json(
      { error: "VSS_INSTANCE_NAME is not set — cannot write to GCS" },
      { status: 400 },
    );
  }

  let prompt: string;
  try {
    prompt = await readPromptLive(DOCKER_MODE);
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to read live prompt: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  const config: PromptConfig = {
    schema: "isv-labs.prompt.v1",
    instance: VSS_INSTANCE_NAME,
    updatedAt: new Date().toISOString(),
    updatedBy: session.user?.email ?? "console",
    prompt,
  };

  try {
    await gcsPromptPut(config);
  } catch (err) {
    return NextResponse.json(
      { error: `GCS write failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    instance: VSS_INSTANCE_NAME,
    promptLength: prompt.length,
  });
}
