import type { ConfigStore } from "@/lib/config-store/types";

/** One-shot, idempotent: ensure the instance has a prompt-set library AND an
 *  active pointer.
 *
 *  - No sets yet: seed a "default" set (migrating any legacy single-doc prompt
 *    text, else the bundled default) and mark it active.
 *  - Sets exist but none is active: activate the "default" set if present, else
 *    the sole set when there's exactly one. This repairs the state where a set
 *    exists but `activePromptId` is unset — which makes the console's
 *    "Current (read-only)" pane render blank (readPrompt returns the active
 *    set's text, and null when nothing is active) even though the VLM is
 *    running fine off a previously-reconciled prompt.
 *
 *  Fail-soft (never throws). */
export async function seedDefaultPromptSet(
  store: Pick<ConfigStore, "readPromptSets" | "readPrompt" | "upsertPromptSet" | "setActivePromptId" | "readActivePromptId">,
  instance: string,
  defaultText: string,
): Promise<void> {
  try {
    const sets = await store.readPromptSets(instance);

    if (sets.length > 0) {
      // Library exists — repair a missing active pointer so "Current" isn't blank.
      const activeId = await store.readActivePromptId(instance);
      const activeStillValid = activeId != null && sets.some((s) => s.id === activeId);
      if (!activeStillValid) {
        const target = sets.find((s) => s.id === "default") ?? (sets.length === 1 ? sets[0] : undefined);
        if (target) await store.setActivePromptId(instance, target.id, "reconciler");
      }
      return;
    }

    // No sets: seed one. With no sets, readPrompt falls back to the legacy
    // single prompt doc, so migrate that text when present.
    const existing = await store.readPrompt(instance);
    const text = (existing?.prompt ?? "").trim() || defaultText.trim();
    if (!text) return;
    await store.upsertPromptSet(
      instance,
      { id: "default", name: "Default (Retail LP)", text, ...(existing?.model ? { model: existing.model } : {}) },
      "reconciler",
    );
    await store.setActivePromptId(instance, "default", "reconciler");
  } catch { /* fail-soft — seeding is best-effort */ }
}
