/**
 * agent-presets.ts — the /agent page's model presets and the pure helpers that
 * classify an LLM endpoint.
 *
 * These live outside `src/app/agent/page.tsx` because a Next.js page file may
 * only export the page conventions: an extra export there passes `tsc` and
 * vitest but fails `next build`. Nothing here touches Kubernetes or `process`,
 * so both the client page and the server-only modules (`incident-report.ts`,
 * `gpu-allocation.ts`, `api/agent-config/route.ts`) import it.
 */

/** Model presets — switch the reasoning LLM (including to Claude) without
 *  hand-typing base URLs. Picking a Claude preset sends llmModelType:
 *  "openai"; the server wires the OpenRouter API key itself via a K8s
 *  secretKeyRef — the UI never asks for or sends a key. */
export const MODEL_PRESETS = [
  {
    id: "nemotron-super-49b",
    label: "Nemotron Super 49B",
    provider: "NVIDIA",
    modelType: "nim",
    baseUrl: "https://integrate.api.nvidia.com",
    name: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
  },
  {
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    provider: "OpenRouter",
    modelType: "openai",
    baseUrl: "https://openrouter.ai/api",
    name: "anthropic/claude-opus-4.8",
  },
  {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    provider: "OpenRouter",
    modelType: "openai",
    baseUrl: "https://openrouter.ai/api",
    name: "anthropic/claude-sonnet-5",
  },
] as const;

export type ModelPreset = (typeof MODEL_PRESETS)[number];

export function normalizeBaseUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, "");
}

/** Preselect the preset whose modelType+baseUrl+name match the live config
 *  (case-insensitive, trailing-slash-insensitive on baseUrl). Returns
 *  undefined when nothing matches — the caller falls back to "custom". */
export function findMatchingPreset(
  modelType: string,
  baseUrl: string,
  name: string,
): ModelPreset | undefined {
  const normBase = normalizeBaseUrl(baseUrl);
  const normName = name.trim().toLowerCase();
  return MODEL_PRESETS.find(
    (p) =>
      p.modelType === modelType &&
      normalizeBaseUrl(p.baseUrl) === normBase &&
      p.name.toLowerCase() === normName,
  );
}

/** True for an endpoint that serves Claude over the OpenAI-compatible chat
 *  surface — OpenRouter (which forwards the body straight to Anthropic) and
 *  Anthropic's own host. Two behaviours key off it: the agent authenticates
 *  with OPENAI_API_KEY rather than NVIDIA_API_KEY, and `temperature` must be
 *  absent from the request body (Claude 4.6+ rejects it there with HTTP 400).
 *  Deliberately NOT the predicate for the native `/v1/models` probe headers —
 *  OpenRouter takes a plain Bearer token, Anthropic's own host needs
 *  `x-api-key` + `anthropic-version`. */
export function isHostedClaudeBaseUrl(baseUrl: string): boolean {
  return /anthropic\.com|openrouter\.ai/.test(baseUrl);
}

/** Provider label for the active model, derived from modelType (+ baseUrl
 *  host for "openai" — openrouter.ai reads as "OpenRouter", anything else as
 *  "OpenAI-compatible"). */
export function providerLabel(modelType: string, baseUrl: string): string {
  if (modelType === "openai") {
    try {
      if (new URL(baseUrl).host === "openrouter.ai") return "OpenRouter";
    } catch {
      // not a parseable URL — fall through to the generic label
    }
    return "OpenAI-compatible";
  }
  return "NVIDIA";
}
