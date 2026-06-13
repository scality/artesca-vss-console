import { describe, it, expect, vi } from "vitest";
import { seedDefaultPromptSet } from "@/lib/reconcile/prompt-seed";
import type { ConfigStore, PromptDoc } from "@/lib/config-store/types";

type SeedStore = Pick<ConfigStore, "readPromptSets" | "readPrompt" | "upsertPromptSet" | "setActivePromptId">;

function store(opts: { sets?: { id: string }[]; legacy?: PromptDoc | null } = {}): SeedStore & {
  upsertPromptSet: ReturnType<typeof vi.fn>;
  setActivePromptId: ReturnType<typeof vi.fn>;
} {
  const sets = [...(opts.sets ?? [])];
  let active = "";
  return {
    readPromptSets: vi.fn(async () => sets),
    readPrompt: vi.fn(async () => opts.legacy ?? null),
    upsertPromptSet: vi.fn(async (_i: string, s: { id: string }) => { sets.push(s); }),
    setActivePromptId: vi.fn(async (_i: string, id: string) => { active = id; void active; }),
  } as never;
}

describe("seedDefaultPromptSet", () => {
  it("seeds the bundled default when there are no sets and no legacy prompt", async () => {
    const s = store();
    await seedDefaultPromptSet(s, "i1", "You are a retail loss-prevention monitor.");
    expect(s.upsertPromptSet).toHaveBeenCalledWith(
      "i1",
      expect.objectContaining({ id: "default", text: "You are a retail loss-prevention monitor." }),
      expect.any(String),
    );
    expect(s.setActivePromptId).toHaveBeenCalledWith("i1", "default", expect.any(String));
  });

  it("migrates an existing legacy prompt into the default set (does NOT shadow it with the bundled default)", async () => {
    const s = store({ legacy: { prompt: "operator edited prompt", model: "m" } });
    await seedDefaultPromptSet(s, "i1", "bundled default");
    expect(s.upsertPromptSet).toHaveBeenCalledWith(
      "i1",
      expect.objectContaining({ id: "default", text: "operator edited prompt", model: "m" }),
      expect.any(String),
    );
  });

  it("no-ops when a prompt-set already exists", async () => {
    const s = store({ sets: [{ id: "x" }] });
    await seedDefaultPromptSet(s, "i1", "default");
    expect(s.upsertPromptSet).not.toHaveBeenCalled();
  });

  it("no-ops when there are no sets, no legacy prompt, and the bundled default is empty", async () => {
    const s = store();
    await seedDefaultPromptSet(s, "i1", "   ");
    expect(s.upsertPromptSet).not.toHaveBeenCalled();
  });
});
