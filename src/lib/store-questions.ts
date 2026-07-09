/**
 * store-questions.ts — turn a plain-English "ask the store" question into a
 * structured filter over the incident archive. Rule-based (deterministic, fast,
 * no LLM dependency): maps keywords → incident category, a known camera name,
 * and a time window. Pure → unit-testable.
 *
 * e.g. "how many theft events today?" → { category: "self-checkout-theft",
 *      hours: 24, windowLabel: "in the last 24h" }
 */
export interface StoreQuestion {
  category?: string;
  camera?: string;
  hours?: number; // undefined = all time
  windowLabel: string;
}

// Deployment categories (kept in sync with the showroom scenarios).
const CATEGORY_KEYWORDS: Array<[RegExp, string]> = [
  [/\b(theft|thefts|steal|stealing|stole|stolen|conceal|shoplift|shoplifting|shrink)\b/i, "self-checkout-theft"],
  [/\b(forklift|forklifts|safety|pallet|pallets|near-?miss|collision)\b/i, "forklift-safety"],
  [/\b(restock|re-?stock|restocking|shelf|shelves|empty|out of stock|stock-?out)\b/i, "shelf-restock"],
  [/\b(intrusion|intruders?|trespass(?:ing)?|break-?in|after[- ]?hours|unauthori[sz]ed)\b/i, "intrusion"],
];

const KNOWN_CAMERAS = [
  "checkout-1",
  "aisle-1",
  "aisle-2",
  "dock-1",
  "dock-2",
  "pyramid-cam0",
  "pyramid-cam1",
];

export function parseStoreQuestion(q: string): StoreQuestion {
  const text = (q ?? "").toLowerCase();

  let category: string | undefined;
  for (const [re, cat] of CATEGORY_KEYWORDS) {
    if (re.test(text)) {
      category = cat;
      break;
    }
  }

  const camera = KNOWN_CAMERAS.find((c) => text.includes(c));

  let hours: number | undefined;
  let windowLabel = "all time";
  if (/\b(this hour|last hour|past hour|in the last hour)\b/.test(text)) {
    hours = 1;
    windowLabel = "in the last hour";
  } else if (/\b(today|last 24|past 24|24 ?h|24 hours|this day)\b/.test(text)) {
    hours = 24;
    windowLabel = "in the last 24h";
  } else if (/\b(this week|last week|past week|7 ?d|7 days|weekly)\b/.test(text)) {
    hours = 168;
    windowLabel = "in the last 7 days";
  } else if (/\b(this month|last month|past month|30 ?d|30 days|monthly)\b/.test(text)) {
    hours = 720;
    windowLabel = "in the last 30 days";
  }

  return { category, camera, hours, windowLabel };
}

/** Human label for a category slug, e.g. "self-checkout-theft" → "self-checkout theft". */
export function categoryLabel(cat: string): string {
  return cat.replace(/-/g, " ");
}
