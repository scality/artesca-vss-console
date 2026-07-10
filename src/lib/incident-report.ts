import "server-only";
import { appsV1, resolveEnvValue } from "@/lib/k8s";
import { CLUSTER } from "@/lib/cluster-refs";
import { AGENT_DEPLOYMENT_NAME, collectAgentBehavior } from "@/lib/agent-config";
import { loadIncidentReport, saveIncidentReport } from "@/lib/db";

/**
 * incident-report.ts — synthesizes a structured markdown incident report
 * (Overview / Location / Involved parties & vehicles / Timeline / Evidence)
 * from a single incident's VLM reasoning text + metadata, using the same
 * reasoning LLM the vss-agent is wired to (see /agent page — LLM_BASE_URL /
 * LLM_NAME / LLM_MODEL_TYPE on the vss-agent Deployment).
 *
 * Fail-soft, matching the rest of the console's collectors: a K8s or LLM
 * failure degrades to a deterministic fallback report + warnings[], never a
 * throw. The only thing that can make this reject is a truly unexpected
 * error persisting to SQLite, which callers surface as a 502.
 */

export interface IncidentReportInput {
  sensorId: string;
  ts: string;
  /** The incident's raw payload (Incident.raw), or the whole console-shaped
   *  Incident object — extractIncidentInfo() accepts either shape. */
  raw?: unknown;
  /** Bypass the cache and regenerate even if a report already exists. */
  force?: boolean;
}

export interface IncidentReportResult {
  markdown: string;
  frames: string[];
  clipUrl?: string;
  cached: boolean;
  warnings?: string[];
}

// ─── Frame / clip URLs ──────────────────────────────────────────────────────
// Mirror the exact shapes used by IncidentDetail.tsx / the /thumb route so a
// report embeds the same, already-cached-and-cheap images the Incidents page
// itself shows — no re-extraction to disk needed here.

function buildThumbUrl(sensorId: string, ts: string): string {
  return `/api/clips/${encodeURIComponent(sensorId)}/${encodeURIComponent(ts)}/thumb`;
}

function buildClipUrl(sensorId: string, ts: string): string {
  return `/api/clips/${encodeURIComponent(sensorId)}/${encodeURIComponent(ts)}/index.m3u8`;
}

// ─── Extracting VLM reasoning + metadata from the incident payload ─────────

interface ExtractedIncidentInfo {
  reasoningText: string;
  triggerPhrase?: string;
  scenarioName?: string;
  category?: string;
  severity?: string;
  summary?: string;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Accepts either:
 *  - a console-shaped Incident object (has .summary/.scenarioName/.severity/
 *    .topic, and possibly its own nested .raw with the original VLM payload), or
 *  - the raw VLM alert payload directly (has .info.reasoningDescription /
 *    .info.triggerPhrase), or
 *  - anything in between / partially populated.
 * Never throws — worst case returns an all-empty ExtractedIncidentInfo.
 */
function extractIncidentInfo(raw: unknown): ExtractedIncidentInfo {
  const info: ExtractedIncidentInfo = { reasoningText: "" };
  const top = asRecord(raw);
  if (!top) return info;

  info.summary = str(top.summary);
  info.scenarioName = str(top.scenarioName);
  info.severity = str(top.severity);
  info.category = str(top.topic);

  // The VLM `info` block can live at top.info (raw payload passed directly)
  // or nested under top.raw.info (a full console Incident object passed in).
  const nestedRaw = asRecord(top.raw) ?? top;
  const vlmInfo = asRecord(nestedRaw.info) ?? asRecord(top.info);
  if (vlmInfo) {
    info.reasoningText = str(vlmInfo.reasoningDescription) ?? info.reasoningText;
    info.triggerPhrase = str(vlmInfo.triggerPhrase);
    if (!info.category) info.category = str(vlmInfo.category);
  }

  if (!info.reasoningText) info.reasoningText = info.summary ?? "";
  return info;
}

// ─── LLM call ────────────────────────────────────────────────────────────────

const REPORT_SYSTEM_PROMPT = `You are a security operations analyst. Given a video-surveillance VLM's reasoning text and incident metadata, write a concise, factual incident report in Markdown.

Produce EXACTLY these four sections, in this order, each as a "## " heading:
## Overview
## Location
## Involved parties & vehicles
## Timeline

Do not add an "Evidence" section or any other section — that is appended separately by the system.
Be concise (a few sentences per section). Do not invent names, plate numbers, or precise times that are not present in the supplied text — if a section can't be determined from the available data, write "Not determinable from available data." for that section instead.`;

function buildUserPrompt(sensorId: string, ts: string, info: ExtractedIncidentInfo): string {
  const lines: string[] = [
    `Camera / sensor: ${sensorId}`,
    `Timestamp: ${ts}`,
  ];
  if (info.scenarioName) lines.push(`Scenario: ${info.scenarioName}`);
  if (info.severity) lines.push(`Severity: ${info.severity}`);
  if (info.category) lines.push(`Category/topic: ${info.category}`);
  if (info.triggerPhrase) lines.push(`Trigger phrase: ${info.triggerPhrase}`);
  lines.push("");
  lines.push("VLM reasoning / description:");
  lines.push(info.reasoningText || "(no reasoning text available for this incident)");
  return lines.join("\n");
}

/** Read the vss-agent's LLM API key off its Deployment env, following a
 *  secretKeyRef when present (mirrors readAgentApiKey in
 *  app/api/agent-config/route.ts — kept local here rather than shared so this
 *  module has no dependency on that route). Never throws; undefined just
 *  means the call goes out unauthenticated. */
async function resolveAgentApiKey(baseUrl: string): Promise<string | undefined> {
  try {
    const deployment = await appsV1().readNamespacedDeployment({
      name: AGENT_DEPLOYMENT_NAME,
      namespace: CLUSTER.vssNamespace,
    });
    const env = deployment.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const ns = CLUSTER.vssNamespace;
    const anthropic = baseUrl.includes("anthropic.com");
    const primary = anthropic ? "OPENAI_API_KEY" : "NVIDIA_API_KEY";
    const secondary = anthropic ? "NVIDIA_API_KEY" : "OPENAI_API_KEY";
    return (
      (await resolveEnvValue(env, primary, ns)) ??
      (await resolveEnvValue(env, secondary, ns))
    );
  } catch {
    return undefined;
  }
}

/** Calls the currently-wired LLM's OpenAI-compatible /v1/chat/completions.
 *  Returns the assistant's markdown, or throws on any failure — callers
 *  catch and fall back to a deterministic report. */
async function callReportLlm(
  baseUrl: string,
  modelName: string,
  modelType: "nim" | "openai",
  sensorId: string,
  ts: string,
  info: ExtractedIncidentInfo,
): Promise<string> {
  const apiKey = await resolveAgentApiKey(baseUrl);
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;

  // Anthropic's OpenAI-compatible endpoint (4.6+) rejects `temperature` on
  // this surface — same gotcha as the /agent page's Claude preset.
  const isAnthropic = modelType === "openai" && baseUrl.includes("anthropic.com");

  const body: Record<string, unknown> = {
    model: modelName || "default",
    messages: [
      { role: "system", content: REPORT_SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(sensorId, ts, info) },
    ],
  };
  if (!isAnthropic) body.temperature = 0.2;

  // The OpenAI-compatible /v1/chat/completions surface (unlike the native
  // /v1/models probe in gpu-allocation.ts) authenticates the same way for
  // both NIM and Anthropic — a plain Bearer token.
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`LLM HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content || !content.trim()) throw new Error("LLM returned an empty response");
  return content.trim();
}

// ─── Deterministic fallback (LLM unreachable / misconfigured) ──────────────

function buildFallbackMarkdown(sensorId: string, ts: string, info: ExtractedIncidentInfo): string {
  const lines: string[] = [];
  lines.push("## Overview");
  lines.push(
    info.reasoningText ||
      info.summary ||
      "No VLM reasoning text was available for this incident.",
  );
  lines.push("");
  lines.push("## Location");
  lines.push(
    `Camera/sensor **${sensorId}**${info.category ? ` (${info.category})` : ""}${
      info.scenarioName ? ` — scenario "${info.scenarioName}"` : ""
    }.`,
  );
  lines.push("");
  lines.push("## Involved parties & vehicles");
  lines.push(
    info.triggerPhrase
      ? `Trigger phrase: "${info.triggerPhrase}".`
      : "Not determinable from available data.",
  );
  lines.push("");
  lines.push("## Timeline");
  lines.push(`Incident recorded at ${ts}${info.severity ? ` (severity: ${info.severity})` : ""}.`);
  return lines.join("\n");
}

function buildEvidenceSection(frames: string[], clipUrl?: string): string {
  const lines = ["## Evidence", ""];
  if (frames.length === 0) {
    lines.push("No frame captures available for this incident.");
  } else {
    for (const frame of frames) lines.push(`![frame](${frame})`);
  }
  if (clipUrl) {
    lines.push("");
    lines.push(`[View clip](${clipUrl})`);
  }
  return lines.join("\n");
}

// ─── Main entry point ────────────────────────────────────────────────────────

export async function generateIncidentReport(
  input: IncidentReportInput,
): Promise<IncidentReportResult> {
  const { sensorId, ts, raw, force } = input;
  const warnings: string[] = [];

  // 1. Serve the cached report unless the caller asked to regenerate.
  if (!force) {
    try {
      const cached = loadIncidentReport(sensorId, ts);
      if (cached) {
        return {
          markdown: cached.markdown,
          frames: cached.frames,
          clipUrl: cached.clipUrl,
          cached: true,
        };
      }
    } catch (err) {
      // Cache read failure shouldn't block generation — fall through.
      warnings.push(
        `Cache lookup failed, generating fresh: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 2. Resolve VLM reasoning text + metadata.
  const info = extractIncidentInfo(raw);
  if (!info.reasoningText) {
    warnings.push("No VLM reasoning text found in the incident payload — report will be sparse.");
  }

  // 3. Frame + clip URLs (same shapes the Incidents page already renders).
  const frames = [buildThumbUrl(sensorId, ts)];
  const clipUrl = buildClipUrl(sensorId, ts);

  // 4. Resolve the live LLM wiring and generate, falling back to a
  //    deterministic report on any failure.
  let bodyMarkdown: string;
  try {
    const behavior = await collectAgentBehavior();
    if (!behavior.llm?.baseUrl) {
      throw new Error("no LLM_BASE_URL configured on the vss-agent Deployment");
    }
    bodyMarkdown = await callReportLlm(
      behavior.llm.baseUrl,
      behavior.llm.modelName,
      behavior.llm.modelType,
      sensorId,
      ts,
      info,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`LLM synthesis unavailable, used a deterministic fallback report: ${msg}`);
    bodyMarkdown = buildFallbackMarkdown(sensorId, ts, info);
  }

  // 5. Append the deterministic Evidence section (real, always-correct URLs —
  //    never left to the LLM to guess at).
  const markdown = `${bodyMarkdown}\n\n${buildEvidenceSection(frames, clipUrl)}`;

  // 6. Persist + return.
  try {
    saveIncidentReport({
      sensorId,
      ts,
      markdown,
      frames,
      clipUrl,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    warnings.push(
      `Report generated but could not be persisted: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    markdown,
    frames,
    clipUrl,
    cached: false,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
