import { describe, it, expect, vi } from "vitest";
import { seedDefaultPromptSet } from "@/lib/reconcile/prompt-seed";
import type { ConfigStore, PromptDoc } from "@/lib/config-store/types";

type SeedStore = Pick<
  ConfigStore,
  "readPromptSets" | "readPrompt" | "upsertPromptSet" | "setActivePromptId" | "readActivePromptId"
>;

function store(opts: { sets?: { id: string }[]; legacy?: PromptDoc | null; active?: string | null } = {}): SeedStore & {
  upsertPromptSet: ReturnType<typeof vi.fn>;
  setActivePromptId: ReturnType<typeof vi.fn>;
} {
  const sets = [...(opts.sets ?? [])];
  let active: string | null = opts.active ?? null;
  return {
    readPromptSets: vi.fn(async () => sets),
    readPrompt: vi.fn(async () => opts.legacy ?? null),
    readActivePromptId: vi.fn(async () => active),
    upsertPromptSet: vi.fn(async (_i: string, s: { id: string }) => { sets.push(s); }),
    setActivePromptId: vi.fn(async (_i: string, id: string) => { active = id; }),
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

  it("does not re-seed when a prompt-set already exists and is active", async () => {
    const s = store({ sets: [{ id: "x" }], active: "x" });
    await seedDefaultPromptSet(s, "i1", "default");
    expect(s.upsertPromptSet).not.toHaveBeenCalled();
    expect(s.setActivePromptId).not.toHaveBeenCalled();
  });

  it("no-ops when there are no sets, no legacy prompt, and the bundled default is empty", async () => {
    const s = store();
    await seedDefaultPromptSet(s, "i1", "   ");
    expect(s.upsertPromptSet).not.toHaveBeenCalled();
  });

  // ── active-pointer repair (sets exist but none active → blank "Current" pane) ──

  it("repairs a missing active pointer by activating 'default' when present", async () => {
    const s = store({ sets: [{ id: "default" }, { id: "other" }], active: null });
    await seedDefaultPromptSet(s, "i1", "default");
    expect(s.upsertPromptSet).not.toHaveBeenCalled();
    expect(s.setActivePromptId).toHaveBeenCalledWith("i1", "default", expect.any(String));
  });

  it("activates the sole set when none is active and there is no 'default'", async () => {
    const s = store({ sets: [{ id: "retail-lp" }], active: null });
    await seedDefaultPromptSet(s, "i1", "default");
    expect(s.setActivePromptId).toHaveBeenCalledWith("i1", "retail-lp", expect.any(String));
  });

  it("stays hands-off when ambiguous: multiple sets, none active, no 'default'", async () => {
    const s = store({ sets: [{ id: "a" }, { id: "b" }], active: null });
    await seedDefaultPromptSet(s, "i1", "default");
    expect(s.setActivePromptId).not.toHaveBeenCalled();
  });

  it("repairs a dangling active pointer that points at a deleted set", async () => {
    const s = store({ sets: [{ id: "default" }], active: "deleted-set" });
    await seedDefaultPromptSet(s, "i1", "default");
    expect(s.setActivePromptId).toHaveBeenCalledWith("i1", "default", expect.any(String));
  });
});
