/**
 * chat-search-routing — route "search the archive" chat messages to the
 * semantic-search worker instead of the vss-agent.
 *
 * The closed upstream vss-agent has no `video_search` tool (a new tool must be
 * built into its Python image, which we don't control), so natural-language
 * archive search can't go through the agent. Instead `/api/chat` detects a
 * search intent and answers from the caption-indexer (`/search`) directly,
 * returning the same OpenAI ChatCompletion shape so the `/chat` page renders it
 * identically — thumbnails inline, each linking to the full Search page.
 *
 * Pure functions only (no fetch here) so the API route owns the network call
 * and both halves stay unit-testable.
 */
import { formatAge } from "@/lib/format-age";
import { cleanCaption, stripTrailingDangling } from "@/lib/search-caption";

export interface SearchHit {
  camera: string;
  ts: string;
  category: string;
  caption: string;
  /** Terse one-line display caption from the worker (LLM/extractive). May be absent on older points. */
  summary?: string;
  incidentId: string;
  score: number;
}

/** Prefer the worker's terse summary; fall back to a client-side clean of the full caption.
 *  A trailing-dangling guard runs on the summary so an old/edge stored summary never
 *  renders ending mid-phrase ("…empty and in"). */
export function displayCaption(hit: Pick<SearchHit, "summary" | "caption">, maxLen = 180): string {
  const s = hit.summary?.trim();
  return (s && stripTrailingDangling(s)) || cleanCaption(hit.caption, maxLen);
}

export interface SearchIntent {
  /** Natural-language query passed to the embedding search. */
  query: string;
  /** Optional camera filter, parsed from the "(sensor: X)" suffix the /chat scope adds. */
  sensor?: string;
}

// Explicit opt-in prefix: "search: forklifts" / "find: theft".
const EXPLICIT_PREFIX = /^\s*(?:search|find)\s*:\s*/i;

// Strong natural-language archive-search phrasings. Kept deliberately tight so
// ordinary agent questions ("how many cameras are live?", "what happened on
// dock-1?") are NOT hijacked — only clear "search the footage" asks route here.
const NATURAL_PATTERNS: RegExp[] = [
  /\b(?:find|show me|search for|look for|pull up|surface)\s+(?:all|every|any)\b/i,
  /\bsearch\s+(?:the\s+)?(?:footage|clips?|incidents?|recordings?|archive|captions?|history|video)\b/i,
  /\b(?:any|all|every)\s+(?:clips?|incidents?|footage|recordings?|events?)\s+(?:of|with|showing|where|involving|about)\b/i,
];

// The /chat scope selector appends this to the wire message when a camera is picked.
const SENSOR_SUFFIX = /\(sensor:\s*([^)]+)\)\s*$/i;

/**
 * Returns a SearchIntent when the message is an archive-search ask, else null
 * (→ forward to the agent as usual).
 */
export function detectSearchIntent(raw: string): SearchIntent | null {
  if (!raw || !raw.trim()) return null;
  let text = raw.trim();

  let sensor: string | undefined;
  const sm = text.match(SENSOR_SUFFIX);
  if (sm && sm.index !== undefined) {
    sensor = sm[1].trim();
    text = text.slice(0, sm.index).trim();
  }

  const explicit = text.match(EXPLICIT_PREFIX);
  if (explicit) {
    const query = text.slice(explicit[0].length).trim();
    return query ? { query, sensor } : null;
  }

  if (NATURAL_PATTERNS.some((re) => re.test(text))) {
    return { query: text, sensor };
  }
  return null;
}

const MAX_CHAT_HITS = 5;

function ageSuffix(ts: string): string {
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
  return ` · ${formatAge(secs)} ago`;
}

function thumbUrl(camera: string, ts: string): string {
  return `/api/clips/${encodeURIComponent(camera)}/${encodeURIComponent(ts)}/thumb`;
}

function searchPageUrl(query: string): string {
  return `/search?q=${encodeURIComponent(query)}`;
}

/**
 * Render search hits as chat markdown. Each hit is a metadata line + a
 * thumbnail still (the img renderer shows /api/clips/.../thumb inline) wrapped
 * in a link to the Search page (where the HLS ClipPlayer handles playback —
 * a raw <video> can't play HLS in Chrome, so we don't fake inline playback).
 */
export function buildSearchReplyMarkdown(query: string, hits: SearchHit[]): string {
  const pageLink = `[Search page](${searchPageUrl(query)})`;
  if (!hits.length) {
    return (
      `I searched the recorded archive for _"${query}"_ but found no matching clips. ` +
      `Try rephrasing, or browse everything on the ${pageLink}.`
    );
  }

  const shown = hits.slice(0, MAX_CHAT_HITS);
  const header =
    `Found **${hits.length}** matching clip${hits.length === 1 ? "" : "s"} ` +
    `in the recorded archive for _"${query}"_:`;

  const blocks = shown.map((h) => {
    const pct = Math.round((h.score ?? 0) * 100);
    const meta = `**${h.camera}** · ${h.category} · ${pct}%${ageSuffix(h.ts)}`;
    const still = `[![${h.camera}](${thumbUrl(h.camera, h.ts)})](${searchPageUrl(query)})`;
    const caption = displayCaption(h, 180);
    return `${meta}\n\n${still}\n\n${caption}`;
  });

  const footerNote =
    hits.length > shown.length
      ? `_Showing the top ${shown.length}. Open the ${pageLink} to see all ${hits.length} and play any clip._`
      : `_Open the ${pageLink} to play any clip._`;

  return [header, ...blocks, "---", footerNote].join("\n\n");
}
