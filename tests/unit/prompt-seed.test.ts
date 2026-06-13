import { describe, it, expect, vi } from "vitest";
import { seedDefaultPromptSet } from "@/lib/reconcile/prompt-seed";
import type { ConfigStore } from "@/lib/config-store/types";

type SeedStore = Pick<ConfigStore, "readPromptSets" | "readActivePromptId" | "upsertPromptSet" | "setActivePromptId">;

function store(initialSets: { id: string }[] = []): SeedStore & {
  upsertPromptSet: ReturnType<typeof vi.fn>;
  setActivePromptId: ReturnType<typeof vi.fn>;
} {
  const sets = [...initialSets];
  let active: string | null = null;
  return {
    readPromptSets: vi.fn(async () => sets),
    readActivePromptId: vi.fn(async () => active),
    upsertPromptSet: vi.fn(async (_i: string, s: { id: string }) => { sets.push(s); }),
    setActivePromptId: vi.fn(async (_i: string, id: string) => { active = id; }),
  } as never;
}

describe("seedDefaultPromptSet", () => {
  it("seeds + activates when empty", async () => {
    const s = store();
    await seedDefaultPromptSet(s, "i1", "You are a retail loss-prevention monitor.");
    expect(s.upsertPromptSet).toHaveBeenCalled();
    expect(s.setActivePromptId).toHaveBeenCalled();
  });
  it("no-ops when a set already exists", async () => {
    const s = store([{ id: "x" }]);
    await seedDefaultPromptSet(s, "i1", "default");
    expect(s.upsertPromptSet).not.toHaveBeenCalled();
  });
  it("no-ops on empty default text", async () => {
    const s = store();
    await seedDefaultPromptSet(s, "i1", "   ");
    expect(s.upsertPromptSet).not.toHaveBeenCalled();
  });
});
