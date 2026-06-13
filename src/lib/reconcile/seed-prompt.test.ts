import { describe, it, expect, vi } from "vitest";
import { seedDefaultPromptIfAbsent } from "./seed-prompt";
import type { ConfigStore, PromptDoc } from "@/lib/config-store/types";

function makeFakeStore(initial: PromptDoc | null) {
  const state: { current: PromptDoc | null; written: PromptDoc | null } = {
    current: initial,
    written: null,
  };
  const store: Pick<ConfigStore, "readPrompt" | "writePrompt"> = {
    readPrompt: async () => state.current,
    writePrompt: async (_instance, p) => {
      state.current = p;
      state.written = p;
    },
  };
  return { store, state };
}

describe("seedDefaultPromptIfAbsent", () => {
  it("seeds the trimmed default when the prompt is absent", async () => {
    const { store, state } = makeFakeStore(null);
    const wrote = await seedDefaultPromptIfAbsent(store, "inst", {
      readDefault: () => "  Be a monitor.  ",
    });
    expect(wrote).toBe(true);
    expect(state.written).toEqual({ prompt: "Be a monitor." });
  });

  it("skips when a prompt is already present", async () => {
    const { store, state } = makeFakeStore({ prompt: "existing" });
    const wrote = await seedDefaultPromptIfAbsent(store, "inst", {
      readDefault: () => "default",
    });
    expect(wrote).toBe(false);
    expect(state.written).toBeNull();
  });

  it("skips and warns when the default is empty", async () => {
    const { store, state } = makeFakeStore(null);
    const warn = vi.fn();
    const wrote = await seedDefaultPromptIfAbsent(store, "inst", {
      readDefault: () => "   ",
      log: { warn },
    });
    expect(wrote).toBe(false);
    expect(state.written).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });
});
