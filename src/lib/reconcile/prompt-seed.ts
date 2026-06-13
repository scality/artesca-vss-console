import type { ConfigStore } from "@/lib/config-store/types";

/** One-shot, idempotent: if the instance has no prompt-sets yet, seed a
 *  "default" set and mark it active. To avoid shadowing an operator's existing
 *  (legacy single-doc) prompt, migrate that prompt's text into the default set
 *  when one is present; otherwise use the bundled default text. Fail-soft
 *  (never throws). */
export async function seedDefaultPromptSet(
  store: Pick<ConfigStore, "readPromptSets" | "readPrompt" | "upsertPromptSet" | "setActivePromptId">,
  instance: string,
  defaultText: string,
): Promise<void> {
  try {
    const sets = await store.readPromptSets(instance);
    if (sets.length > 0) return;
    // With no sets, readPrompt falls back to the legacy single prompt doc.
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
