/**
 * cleanCaption — turn a raw VLM reasoning caption into a concise display line.
 *
 * The caption-indexer embeds the RICHEST available VLM text (usually the full
 * `reasoningDescription`) so semantic matching has the most signal to work
 * with. That text is often verbose and opens with conversational filler
 * ("Okay, let's break this down.", "Looking at the scene,"). This trims it for
 * DISPLAY only — the stored caption (used for embedding, and shown in the
 * incident detail dialog) is untouched.
 *
 * Pure + isomorphic: safe to import from both server routes and client pages.
 */

// Leading conversational filler the VLM tends to prepend. Peeled repeatedly so
// stacked openers ("Okay. Let me analyze the frame.") both come off.
const LEADING_FILLER: RegExp[] = [
  /^(?:okay|ok|alright|sure|well|so|now|hmm)[,.\s]+/i,
  /^let'?s (?:break this down|analyze[^.]*|see|take a look)[.,\s]*/i,
  /^let me (?:break this down|analyze[^.]*|think[^.]*|see|take a look)[.,\s]*/i,
  /^looking at (?:the )?(?:scene|image|frame|footage|video)[,.\s]*/i,
  /^(?:based on|from) (?:the )?(?:scene|image|frame|footage|video|description)[,.\s]*/i,
  /^here'?s (?:what|a)[^.]*[.\s]+/i,
  /^in (?:this|the) (?:scene|image|frame|footage|clip)[,.\s]*/i,
  // VLM meta-narration: some reasoning captions restate the task instead of
  // describing the scene ("The user provided a detailed description of …").
  // Peel the opener to surface the actual scene text.
  /^the user (?:provided|gave|shared|supplied)(?:\s+\w+){0,3}\s+description of\s+/i,
  // Drop a whole leading "The user asked/provided … ." sentence, but only when
  // a following sentence exists (trailing \s+) so a bare meta caption is kept.
  /^the user\b[^.]*\.\s+/i,
  // Chain-of-thought openers the VLM emits before the real description
  // ("First, I need to parse the video carefully. The forklift is …"). Each
  // requires a trailing sentence so a bare caption is never emptied.
  /^first,?\s+I (?:need to|have to|should|will|must|want to)\b[^.]*\.\s+/i,
  /^(?:I|we) (?:need to|have to|should|will|must|want to)\b[^.]*\.\s+/i,
  /^let me (?:start by|first|begin)\b[^.]*\.\s+/i,
];

// Connective/function words that read as dangling if a (truncated) caption
// ends on them — mirrors the worker's _DANGLING set. Applied as a display-side
// guard so no stored summary ever renders ending mid-phrase ("…empty and in").
const TRAILING_DANGLING = new Set([
  "and", "or", "but", "with", "to", "the", "a", "an", "of", "in", "on", "at",
  "near", "for", "from", "by", "as", "into", "onto", "over", "under", "that",
  "which", "while", "then", "is", "are", "was", "were", "their", "its",
]);

export function stripTrailingDangling(s: string): string {
  const words = (s ?? "").trim().split(/\s+/);
  while (
    words.length > 1 &&
    TRAILING_DANGLING.has(words[words.length - 1].toLowerCase().replace(/[,;:]+$/, ""))
  ) {
    words.pop();
  }
  return words.join(" ");
}

export function cleanCaption(raw: string, maxLen = 200): string {
  let s = (raw ?? "")
    .replace(/<[^>]+>/g, " ") // drop any stray markup/tags
    .replace(/\s+/g, " ")
    .trim();

  let changed = true;
  while (changed) {
    changed = false;
    for (const re of LEADING_FILLER) {
      const next = s.replace(re, "").trim();
      if (next !== s && next.length > 0) {
        s = next;
        changed = true;
      }
    }
  }

  if (s) s = s[0].toUpperCase() + s.slice(1);
  if (s.length <= maxLen) return s;

  // Prefer cutting at a sentence boundary within the budget.
  const slice = s.slice(0, maxLen);
  const lastStop = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? "),
  );
  if (lastStop > maxLen * 0.5) return slice.slice(0, lastStop + 1).trim();
  return stripTrailingDangling(slice.trimEnd()) + "…";
}
