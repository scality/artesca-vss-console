import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRotationAge } from "@/lib/db";

export const dynamic = "force-dynamic";

const NAG_THRESHOLD_DAYS = 90;

const ROTATABLE_KEYS = [
  { key: "camera-sim-ssh", label: "Camera-sim SSH key" },
  { key: "aws-creds", label: "AWS credentials" },
  { key: "ngc-key", label: "NGC API key" },
  { key: "nvidia-api-key", label: "NVIDIA API key" },
  { key: "hf-token", label: "HuggingFace token" },
  { key: "slack-webhook", label: "Slack webhook" },
  { key: "console-password", label: "Console password" },
];

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rotations = ROTATABLE_KEYS.map(({ key, label }) => {
    const ageMs = getRotationAge(key);
    const ageDays = ageMs !== null ? Math.floor(ageMs / (1000 * 60 * 60 * 24)) : null;
    const nagBanner = ageDays !== null && ageDays >= NAG_THRESHOLD_DAYS;

    return {
      key,
      label,
      ageDays,
      nagBanner,
      lastRotatedAt: ageMs !== null ? new Date(Date.now() - ageMs).toISOString() : null,
    };
  });

  return NextResponse.json({ rotations });
}
