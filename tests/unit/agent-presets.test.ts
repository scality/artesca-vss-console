import { describe, it, expect } from "vitest";
import {
  MODEL_PRESETS,
  findMatchingPreset,
  isHostedClaudeBaseUrl,
  providerLabel,
} from "@/lib/agent-presets";

const claudePresets = () => MODEL_PRESETS.filter((p) => p.provider === "OpenRouter");

describe("providerLabel", () => {
  it("reads openrouter.ai as OpenRouter", () => {
    expect(providerLabel("openai", "https://openrouter.ai/api")).toBe("OpenRouter");
  });

  it("keeps the generic label for any other OpenAI-compatible host", () => {
    expect(providerLabel("openai", "https://integrate.api.nvidia.com")).toBe(
      "OpenAI-compatible",
    );
  });

  it("falls back to the generic label on an unparseable URL", () => {
    expect(providerLabel("openai", "not a url")).toBe("OpenAI-compatible");
  });

  it("reads a nim model type as NVIDIA whatever the URL", () => {
    expect(providerLabel("nim", "https://openrouter.ai/api")).toBe("NVIDIA");
  });
});

describe("MODEL_PRESETS", () => {
  it("routes both Claude presets through OpenRouter", () => {
    const claude = claudePresets();
    expect(claude).toHaveLength(2);
    for (const p of claude) {
      expect(p.baseUrl).toBe("https://openrouter.ai/api");
      expect(p.modelType).toBe("openai");
      expect(providerLabel(p.modelType, p.baseUrl)).toBe("OpenRouter");
    }
  });

  it("carries the vendor-prefixed OpenRouter model ids", () => {
    expect(claudePresets().map((p) => p.name).sort()).toEqual([
      "anthropic/claude-opus-4.8",
      "anthropic/claude-sonnet-5",
    ]);
  });

  it("leaves the NIM preset on the NVIDIA endpoint", () => {
    const nim = MODEL_PRESETS.find((p) => p.modelType === "nim");
    expect(nim?.baseUrl).toBe("https://integrate.api.nvidia.com");
    expect(nim?.provider).toBe("NVIDIA");
  });
});

describe("findMatchingPreset", () => {
  it("matches a live config with a trailing slash and mixed case", () => {
    expect(
      findMatchingPreset("openai", "https://OpenRouter.ai/api/", "Anthropic/Claude-Sonnet-5")?.id,
    ).toBe("claude-sonnet-5");
  });

  it("returns undefined when nothing matches", () => {
    expect(findMatchingPreset("openai", "https://example.invalid", "x")).toBeUndefined();
  });
});

describe("isHostedClaudeBaseUrl", () => {
  it("is true for the OpenRouter endpoint", () => {
    expect(isHostedClaudeBaseUrl("https://openrouter.ai/api")).toBe(true);
  });

  it("is true for Anthropic's own endpoint", () => {
    expect(isHostedClaudeBaseUrl("https://api.anthropic.com")).toBe(true);
  });

  it("is false for a NIM endpoint", () => {
    expect(isHostedClaudeBaseUrl("https://integrate.api.nvidia.com")).toBe(false);
  });
});
