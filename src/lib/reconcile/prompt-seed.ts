import type { ConfigStore } from "@/lib/config-store/types";

/** One-shot, idempotent: if no prompt-sets exist, create a "default" set from
 *  the bundled default prompt and mark it active. Fail-soft (never throws). */
export async function seedDefaultPromptSet(
  store: Pick<ConfigStore, "readPromptSets" | "readActivePromptId" | "upsertPromptSet" | "setActivePromptId">,
  instance: string,
  defaultText: string,
): Promise<void> {
  try {
    if (!defaultText.trim()) return;
    const sets = await store.readPromptSets(instance);
    if (sets.length > 0) return;
    await store.upsertPromptSet(instance, { id: "default", name: "Default (Retail LP)", text: defaultText }, "reconciler");
    await store.setActivePromptId(instance, "default", "reconciler");
  } catch { /* fail-soft — seeding is best-effort */ }
}
