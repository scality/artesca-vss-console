import type { ConfigStore } from "@/lib/config-store/types";

export interface SeedPromptDeps {
  /** Returns the bundled default prompt text (trimmed or not). */
  readDefault: () => string;
  log?: { info?: (msg: string) => void; warn?: (msg: string) => void };
}

/**
 * Seed the instance's prompt doc from the bundled default, only if absent.
 * Idempotent: once a prompt exists (seeded or operator-edited) this is a no-op,
 * so it never clobbers an edited prompt. Returns true iff it wrote a seed.
 */
export async function seedDefaultPromptIfAbsent(
  store: Pick<ConfigStore, "readPrompt" | "writePrompt">,
  instance: string,
  deps: SeedPromptDeps,
): Promise<boolean> {
  const existing = await store.readPrompt(instance);
  if (existing) return false;

  const def = deps.readDefault().trim();
  if (!def) {
    deps.log?.warn?.("default prompt empty/missing — not seeding");
    return false;
  }

  await store.writePrompt(instance, { prompt: def }, "deploy-seed");
  deps.log?.info?.(`seeded default VLM prompt (${def.length} chars)`);
  return true;
}
