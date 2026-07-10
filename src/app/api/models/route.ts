import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ModelCardSchema } from "@/lib/schemas";
import modelCatalog from "@/data/model-catalog.json";
import { createLogger } from "@/lib/logger";
import { readLiveVlm } from "@/lib/helpers/live-vlm";

const log = createLogger("api/models");

export const dynamic = "force-dynamic";

// The VLM is swapped from a catalog only on the docker/compose path. On k8s
// (Helm profiles) the VLM is chart-fixed; the console shows it read-only and
// routes reasoning-model changes to /agent.
const DOCKER_MODE = process.env.CONSOLE_RUNTIME === "docker";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Validate catalog at runtime so schema mismatches surface early
  const parsed = modelCatalog
    .map((m, i) => {
      const result = ModelCardSchema.safeParse(m);
      if (!result.success) {
        log.warn("catalog entry invalid", { index: i, issues: result.error.issues });
        return null;
      }
      return result.data;
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);

  // currentModel: env var wins, else first catalog entry (matches displayed grid order).
  // Matches by either the full image ref or a displayName/short token — we only resolve
  // against the catalog so unknown env values fall through to the default.
  const resolve = (raw: string | undefined): string | undefined => {
    if (!raw) return undefined;
    const needle = raw.trim();
    if (!needle) return undefined;
    const exact = parsed.find((m) => m.image === needle);
    if (exact) return exact.image;
    const partial = parsed.find(
      (m) => m.image.includes(needle) || m.displayName.toLowerCase().includes(needle.toLowerCase()),
    );
    return partial?.image;
  };

  const previewModel = resolve(process.env.NIM_PREVIEW_MODEL);

  // On k8s, report the VLM that is actually deployed (read live from the
  // Deployment) — not a catalog default. Swapping isn't offered here; the VLM is
  // chart-managed and the reasoning model is changed on /agent.
  const activeModel = DOCKER_MODE ? null : await readLiveVlm();
  const swappable = DOCKER_MODE;

  // currentModel highlights a catalog card (docker/compose swap grid). Prefer the
  // live-active image when known, else the env hint, else the first catalog entry.
  const currentModel =
    resolve(activeModel?.image) ??
    resolve(process.env.NIM_CURRENT_MODEL) ??
    activeModel?.image ??
    parsed[0]?.image ??
    "";

  return NextResponse.json({
    models: parsed,
    currentModel,
    previewModel,
    activeModel,
    swappable,
    reasoningModelHref: "/agent",
  });
}
