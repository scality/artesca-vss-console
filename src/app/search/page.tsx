"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Search } from "lucide-react";
import { Shell } from "@/components/Shell";
import { ClipPlayer } from "@/components/incidents/ClipPlayer";
import { formatAge } from "@/lib/format-age";
import { displayCaption } from "@/lib/chat-search-routing";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SearchHit {
  camera: string;
  ts: string;
  category: string;
  caption: string;
  summary?: string;
  incidentId: string;
  score: number;
}

interface SearchResponse {
  hits: SearchHit[];
  error?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildThumbUrl(camera: string, ts: string): string {
  return `/api/clips/${encodeURIComponent(camera)}/${encodeURIComponent(ts)}/thumb`;
}

function buildClipUrl(camera: string, ts: string): string {
  return `/api/clips/${encodeURIComponent(camera)}/${encodeURIComponent(ts)}/index.m3u8`;
}

/** Compute elapsed seconds from an ISO timestamp to now. */
function ageSeconds(ts: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1_000));
}

/** Truncate a string to maxLen, adding an ellipsis when needed. */
function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen) + "…" : s;
}

/** Render the cosine similarity score as a colour-coded chip. */
function ScoreChip({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const colour =
    pct >= 80
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : pct >= 60
      ? "bg-amber-50 text-amber-700 border-amber-200"
      : "bg-muted text-muted-foreground border-border";
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium tabular-nums ${colour}`}
      title={`Semantic similarity score: ${(score * 100).toFixed(1)}%`}
    >
      {pct}%
    </span>
  );
}

// ─── Hit card ─────────────────────────────────────────────────────────────────

interface HitCardProps {
  hit: SearchHit;
  onClick: () => void;
}

function HitCard({ hit, onClick }: HitCardProps) {
  const thumbUrl = buildThumbUrl(hit.camera, hit.ts);
  const absTime = new Date(hit.ts).toLocaleString();
  const ageS = ageSeconds(hit.ts);

  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative flex flex-col overflow-hidden rounded-lg border border-border bg-card text-left shadow-sm transition-all hover:shadow-md hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {/* Thumbnail — 16:9 aspect ratio */}
      <div className="relative aspect-video w-full overflow-hidden bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={thumbUrl}
          alt={`Snapshot for ${hit.camera}`}
          loading="lazy"
          className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
        {/* Score badge overlaid on thumbnail */}
        <span className="absolute bottom-1.5 right-1.5 backdrop-blur-sm">
          <ScoreChip score={hit.score} />
        </span>
      </div>

      {/* Metadata block */}
      <div className="flex flex-col gap-0.5 px-2 py-2">
        <p className="truncate font-mono text-xs font-medium text-foreground">
          {hit.camera}
        </p>
        <p className="truncate text-xs text-muted-foreground">{hit.category}</p>
        <p
          className="text-[11px] tabular-nums text-muted-foreground"
          title={absTime}
        >
          {formatAge(ageS)} ago
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-foreground/80 line-clamp-2">
          {truncate(displayCaption(hit), 140)}
        </p>
      </div>
    </button>
  );
}

// ─── Clip detail dialog ────────────────────────────────────────────────────────

interface HitDetailProps {
  hit: SearchHit | null;
  onClose: () => void;
}

function HitDetail({ hit, onClose }: HitDetailProps) {
  if (!hit) return null;

  const clipUrl = buildClipUrl(hit.camera, hit.ts);

  return (
    <Dialog open={!!hit} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm">{hit.camera}</span>
            <ScoreChip score={hit.score} />
            <span className="text-xs text-muted-foreground">
              {new Date(hit.ts).toLocaleString()}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Category + caption */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Category</p>
              <p className="font-medium">{hit.category}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Incident ID</p>
              <p className="font-mono text-xs truncate">{hit.incidentId}</p>
            </div>
          </div>

          <div>
            <p className="text-xs text-muted-foreground mb-1">Summary</p>
            <p className="text-sm leading-relaxed">{displayCaption(hit)}</p>
          </div>

          {hit.caption?.trim() && hit.caption.trim() !== displayCaption(hit) && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">Full description</p>
              <p className="whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
                {hit.caption}
              </p>
            </div>
          )}

          {/* Clip player */}
          <div>
            <p className="text-xs text-muted-foreground mb-1.5">Clip</p>
            <ClipPlayer
              src={clipUrl}
              fallbackMeta={{
                ts: hit.ts,
                sensorId: hit.camera,
                severity: "medium",
                summary: hit.caption,
                scenarioName: hit.category,
              }}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main search page ─────────────────────────────────────────────────────────

const EXAMPLE_QUERIES = [
  "forklift near the shelves",
  "someone concealing an item at checkout",
];

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SearchHit | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const runSearch = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;

    // Own the query state so callers (form submit, example chip, ?q= deep link)
    // don't each have to setQuery separately — and the mount effect below stays
    // free of a synchronous setState in its body.
    setQuery(trimmed);
    setLoading(true);
    setError(null);
    setSearched(true);
    setHits([]);

    try {
      const resp = await fetch("/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: trimmed, limit: 20 }),
      });

      const data: SearchResponse = await resp.json();

      if (!resp.ok || data.error) {
        setError(data.error ?? `HTTP ${resp.status}`);
        setHits([]);
      } else {
        setHits(data.hits ?? []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setHits([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      runSearch(query);
    },
    [query, runSearch],
  );

  // Deep-link: /search?q=… (used by the chat search-routing thumbnails) pre-fills
  // the box and runs the search on mount. Read from location rather than
  // useSearchParams to avoid the Next 16 Suspense-boundary requirement.
  // Deferred off the effect's synchronous tick so runSearch's setState doesn't
  // cascade within the effect body; ref-guarded against a StrictMode double-run.
  const deepLinkRan = useRef(false);
  useEffect(() => {
    if (deepLinkRan.current) return;
    const q = new URLSearchParams(window.location.search).get("q");
    if (q && q.trim()) {
      deepLinkRan.current = true;
      queueMicrotask(() => void runSearch(q));
    }
  }, [runSearch]);

  const applyExampleQuery = useCallback(
    (q: string) => {
      setQuery(q);
      inputRef.current?.focus();
      runSearch(q);
    },
    [runSearch],
  );

  return (
    <Shell>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold">Semantic Search</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Search incident captions by meaning — powered by vector embeddings
          </p>
        </div>

        {/* Search form */}
        <form onSubmit={handleSubmit} className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Describe what you are looking for…"
              className="w-full rounded-md border border-input bg-background pl-9 pr-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              disabled={loading}
            />
          </div>
          <button
            type="submit"
            disabled={loading || !query.trim()}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? (
              <>
                <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
                Searching…
              </>
            ) : (
              "Search"
            )}
          </button>
        </form>

        {/* Example queries */}
        {!searched && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Try:</span>
            {EXAMPLE_QUERIES.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => applyExampleQuery(q)}
                className="rounded-full border border-border bg-muted/50 px-3 py-1 text-xs text-foreground hover:bg-muted transition-colors"
              >
                {q}
              </button>
            ))}
          </div>
        )}

        {/* Error state */}
        {error && (
          <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
            <span className="shrink-0 mt-0.5">&#9888;</span>
            <span>{error}</span>
          </div>
        )}

        {/* Loading skeleton */}
        {loading && (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="flex flex-col overflow-hidden rounded-lg border border-border bg-card"
              >
                <div className="aspect-video w-full animate-pulse bg-muted" />
                <div className="flex flex-col gap-1.5 px-2 py-2">
                  <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-full animate-pulse rounded bg-muted" />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Empty state — after a completed search with no hits */}
        {!loading && searched && !error && hits.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-12 text-center">
            <Search className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm font-medium text-muted-foreground">No matches found</p>
            <p className="text-xs text-muted-foreground/70">
              Try rephrasing your query or broadening the description.
            </p>
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              {EXAMPLE_QUERIES.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => applyExampleQuery(q)}
                  className="rounded-full border border-border bg-muted/50 px-3 py-1 text-xs text-foreground hover:bg-muted transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Results grid */}
        {!loading && hits.length > 0 && (
          <>
            <p className="text-xs text-muted-foreground">
              {hits.length} match{hits.length !== 1 ? "es" : ""} — click a card to play the clip
            </p>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {hits.map((hit) => (
                <HitCard
                  key={`${hit.camera}::${hit.ts}::${hit.incidentId}`}
                  hit={hit}
                  onClick={() => setSelected(hit)}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Clip detail dialog */}
      <HitDetail hit={selected} onClose={() => setSelected(null)} />
    </Shell>
  );
}
