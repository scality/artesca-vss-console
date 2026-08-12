import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { createLogger } from "@/lib/logger";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { auditLog } from "@/lib/helpers/audit";
import { configStoreKind } from "@/lib/config-store";
import { FileConfigStore, configFilePath, CONFIG_SCHEMA } from "@/lib/config-store/file";
import { makeFirestoreConfigStore } from "@/lib/config-store/firestore";
import type { CameraEntry, PromptSet, ScenarioEntry } from "@/lib/config-store/types";

export const dynamic = "force-dynamic";

const log = createLogger("api/config-store/migrate");

/**
 * Copy one instance's configuration from Firestore into the YAML file store (ISVD-606).
 *
 * A route rather than a script, because the copy needs both halves at once and the
 * pod is the only place that has them: the optional Firestore SDK (the published
 * image is built with `WITH_FIRESTORE=1`) and the `console-data` volume the file
 * store writes to. A standalone Node script in the image cannot load the store
 * modules at all — they are TypeScript behind the `@/` alias — and reimplementing
 * the YAML layout in it would be a second definition of the file format.
 *
 *   # dry run: reports both sides, writes nothing
 *   kubectl -n console exec deploy/console -- \
 *     curl -sS -XPOST localhost:8800/api/config-store/migrate
 *
 *   # perform the copy
 *   kubectl -n console exec deploy/console -- \
 *     curl -sS -XPOST 'localhost:8800/api/config-store/migrate?apply=1'
 *
 * ⚠ It reads Firestore **directly**, not through `makeConfigStore()`. That factory
 * returns whichever backend is selected, so after a cutover it would return the
 * destination — and the copy would be the file store onto itself, reporting
 * success while doing nothing.
 *
 * ⚠ It does not switch the backend. `CONSOLE_CONFIG_STORE` is a ConfigMap key and
 * changing it restarts the pod, so doing both here would migrate and cut over in
 * one step with no interval in which to check the result. The response says what
 * to run next.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;

  const apply = req.nextUrl.searchParams.get("apply") === "1";
  const force = req.nextUrl.searchParams.get("force") === "1";
  const instance = req.nextUrl.searchParams.get("instance") ?? process.env.VSS_INSTANCE_NAME ?? "";
  if (!instance) {
    return NextResponse.json(
      { error: "no instance: pass ?instance=<name> or set VSS_INSTANCE_NAME" },
      { status: 400 },
    );
  }

  let source;
  try {
    source = await makeFirestoreConfigStore();
  } catch (err) {
    // Distinguishing these matters: an absent SDK is a build that cannot do this
    // at all, while a missing project id is a variable to supply. Both arrive
    // here as one Error, so the message is passed through rather than recast.
    return NextResponse.json(
      { error: `cannot read the Firestore store: ${err instanceof Error ? err.message : String(err)}` },
      { status: 400 },
    );
  }

  const dest = new FileConfigStore();

  let src: {
    cameras: CameraEntry[];
    scenarios: ScenarioEntry[];
    promptSets: PromptSet[];
    activePromptId: string | null;
    prompt: { prompt: string; model?: string } | null;
  };
  let existing;
  try {
    const [cameras, scenarios, promptSets, activePromptId, status] = await Promise.all([
      source.readCameras(instance),
      source.readScenarios(instance),
      source.readPromptSets(instance),
      source.readActivePromptId(instance),
      source.readStatus(instance),
    ]);
    // readPrompt() resolves the active set first, so it cannot be used to find
    // out whether a *legacy* prompt doc exists. Read it with no active id in the
    // way by asking after the sets are known.
    const legacy = activePromptId ? null : await source.readPrompt(instance);
    src = { cameras, scenarios, promptSets, activePromptId, prompt: legacy };
    void status;
    existing = await dest.read(instance);
  } catch (err) {
    log.error("migrate: read failed", { err });
    return NextResponse.json(
      { error: `read failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  const report = {
    instance,
    activeBackend: configStoreKind(),
    destination: configFilePath(instance),
    source: {
      cameras: src.cameras.length,
      scenarios: src.scenarios.length,
      promptSets: src.promptSets.length,
      activePromptId: src.activePromptId,
      legacyPrompt: Boolean(src.prompt),
    },
    destinationBefore: {
      cameras: existing.cameras.length,
      scenarios: existing.scenarios.length,
      promptSets: existing.promptSets.length,
    },
  };

  // Refuse a destination that already holds something. Once the cutover has
  // happened the file store is live, so re-running would replace real edits with
  // a Firestore copy that is stale by definition.
  const destHasData =
    existing.cameras.length || existing.scenarios.length || existing.promptSets.length;
  if (destHasData && !force) {
    return NextResponse.json(
      {
        ...report,
        error:
          "the file store already holds data for this instance; re-running would replace it with " +
          "the Firestore copy, which is stale once the cutover has happened. Add &force=1 only if " +
          "that is what you mean.",
      },
      { status: 409 },
    );
  }

  if (!apply) return NextResponse.json({ ...report, applied: false, note: "dry run — add ?apply=1" });

  try {
    // Written through the store's own methods, so the result is a document the
    // app validates on read rather than YAML this route believes is right.
    await dest.writeCameras(instance, src.cameras, "config-store-migrate");
    await dest.writeScenarios(instance, src.scenarios, "config-store-migrate");
    for (const set of src.promptSets) {
      await dest.upsertPromptSet(instance, set, "config-store-migrate");
    }
    if (src.prompt) await dest.writePrompt(instance, src.prompt, "config-store-migrate");
    if (src.activePromptId) {
      await dest.setActivePromptId(instance, src.activePromptId, "config-store-migrate");
    }

    // Read back through the validator. A write that produced a file the reader
    // then refuses to parse is the one outcome that must not report success.
    const after = await dest.read(instance);
    const mismatches = (
      [
        ["cameras", src.cameras.length, after.cameras.length],
        ["scenarios", src.scenarios.length, after.scenarios.length],
        ["promptSets", src.promptSets.length, after.promptSets.length],
      ] as const
    ).filter(([, a, b]) => a !== b);
    if (after.schema !== CONFIG_SCHEMA || mismatches.length) {
      return NextResponse.json(
        {
          ...report,
          applied: true,
          verified: false,
          error: "wrote the file but read it back differently — do not cut over",
          mismatches: mismatches.map(([k, want, got]) => ({ kind: k, want, got })),
        },
        { status: 500 },
      );
    }

    await auditLog("config-store-migrate", `instance/${instance}`, report.source);
    log.info(`migrated ${instance} from firestore to the file store`, report.source);

    return NextResponse.json({
      ...report,
      applied: true,
      verified: true,
      next: [
        `kubectl -n console patch cm console-env --type merge -p '{"data":{"CONSOLE_CONFIG_STORE":"file"}}'`,
        "kubectl -n console rollout restart deploy/console deploy/reconcile-agent",
      ],
    });
  } catch (err) {
    log.error("migrate: write failed", { err });
    return NextResponse.json(
      { ...report, applied: false, error: `write failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}
