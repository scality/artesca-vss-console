// Scality 2026 brand accent palette + deterministic picker.
// Vendored from @scality/portal-ui (scality-portal). Gives each card/category
// a stable colour (icon circle + arrow), mirroring the /portal HubTile look.
export const BRAND_ACCENTS = [
  "var(--color-brand-teal)",
  "var(--color-brand-indigo)",
  "var(--color-brand-magenta)",
  "var(--color-brand-orange)",
  "var(--color-brand-teal-light)",
] as const;

/** Stable accent for a key (e.g. a category slug) — same key always maps to
 *  the same colour, so the palette reads as intentional, not random. */
export function accentFor(key: string): string {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return BRAND_ACCENTS[h % BRAND_ACCENTS.length];
}
