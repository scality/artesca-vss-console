"use client";

import { useCallback, useEffect, useState } from "react";
import { BarChart3, Send } from "lucide-react";
import { Shell } from "@/components/Shell";
import { parseStoreQuestion, categoryLabel } from "@/lib/store-questions";

interface Stats {
  total: number;
  byCategory: Record<string, number>;
  byCamera: Record<string, number>;
  byDay: Array<{ day: string; count: number }>;
  error?: string;
}

interface Answer {
  question: string;
  text: string;
  clipQuery: string;
  error?: boolean;
}

const WINDOWS: Array<{ label: string; hours?: number }> = [
  { label: "Last 24h", hours: 24 },
  { label: "Last 7 days", hours: 168 },
  { label: "Last 30 days", hours: 720 },
  { label: "All time", hours: undefined },
];

const EXAMPLES = [
  "How many theft events today?",
  "Forklift safety incidents this week",
  "Which shelves needed restocking this week?",
];

async function fetchStats(hours?: number): Promise<Stats> {
  const qs = hours ? `?hours=${hours}` : "";
  const r = await fetch(`/api/analytics${qs}`, { cache: "no-store" });
  const body = (await r.json()) as Stats;
  // A non-2xx or a body carrying `error` means the worker proxy failed —
  // never treat the zeroed fallback shape as a real (empty) answer.
  if (!r.ok || body.error) {
    throw new Error(body.error || `analytics HTTP ${r.status}`);
  }
  return body;
}

function BarRow({ label, count, max }: { label: string; count: number; max: number }) {
  const pct = max > 0 ? (count / max) * 100 : 0;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-40 shrink-0 truncate">{label}</span>
      <div className="h-3 flex-1 overflow-hidden rounded bg-muted">
        <div className="h-full rounded bg-brand-teal" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-10 shrink-0 text-right tabular-nums font-medium">{count}</span>
    </div>
  );
}

function Bars({ data }: { data?: Record<string, number> }) {
  const entries = Object.entries(data ?? {}).sort((a, b) => b[1] - a[1]);
  const max = entries.length ? entries[0][1] : 0;
  if (!entries.length) return <p className="text-xs text-muted-foreground">No incidents in this window.</p>;
  return (
    <div className="space-y-1.5">
      {entries.map(([label, count]) => (
        <BarRow key={label} label={categoryLabel(label)} count={count} max={max} />
      ))}
    </div>
  );
}

export default function AnalyticsPage() {
  const [hours, setHours] = useState<number | undefined>(168);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [asking, setAsking] = useState(false);

  const load = useCallback(async (h: number | undefined) => {
    setLoading(true);
    try {
      setStats(await fetchStats(h));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "network error";
      setStats({ total: 0, byCategory: {}, byCamera: {}, byDay: [], error: msg });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Defer off the effect's sync tick so load()'s setState isn't an in-effect cascade.
    queueMicrotask(() => void load(hours));
  }, [hours, load]);

  const ask = useCallback(async (qRaw: string) => {
    const q = qRaw.trim();
    if (!q) return;
    setAsking(true);
    setAnswer(null);
    try {
      const parsed = parseStoreQuestion(q);
      const s = await fetchStats(parsed.hours);
      let count: number;
      let subject: string;
      if (parsed.category) {
        count = s.byCategory?.[parsed.category] ?? 0;
        subject = `${categoryLabel(parsed.category)} incident${count === 1 ? "" : "s"}`;
      } else if (parsed.camera) {
        count = s.byCamera?.[parsed.camera] ?? 0;
        subject = `incident${count === 1 ? "" : "s"} on ${parsed.camera}`;
      } else {
        count = s.total ?? 0;
        subject = `incident${count === 1 ? "" : "s"}`;
      }
      const where = parsed.camera && parsed.category ? ` on ${parsed.camera}` : "";
      setAnswer({
        question: q,
        text: `${count} ${subject}${where} ${parsed.windowLabel}.`,
        clipQuery: q,
      });
    } catch (e) {
      // Never present a confident "0 incidents" answer when the backend actually failed.
      const msg = e instanceof Error ? e.message : "network error";
      setAnswer({ question: q, text: `Analytics unavailable — ${msg}`, clipQuery: q, error: true });
    } finally {
      setAsking(false);
    }
  }, []);

  const dayMax = stats?.byDay?.length ? Math.max(...stats.byDay.map((d) => d.count)) : 0;

  return (
    <Shell>
      <div className="space-y-6">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <BarChart3 className="h-6 w-6 text-brand-teal" />
            Ask the store
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Analytics over everything the video AI has seen — counts, trends, and the clips behind them.
          </p>
        </div>

        {/* Ask box */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void ask(question);
          }}
          className="flex gap-2"
        >
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask a question, e.g. “how many theft events today?”"
            className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="submit"
            disabled={asking || !question.trim()}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
            Ask
          </button>
        </form>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Try:</span>
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => {
                setQuestion(ex);
                void ask(ex);
              }}
              className="rounded-full border border-border bg-muted/50 px-3 py-1 text-xs hover:bg-muted"
            >
              {ex}
            </button>
          ))}
        </div>

        {answer && (
          <div
            className={`rounded-lg border px-4 py-3 ${
              answer.error
                ? "border-red-300 bg-red-50"
                : "border-brand-teal/40 bg-brand-teal-soft/40"
            }`}
          >
            <p className="text-xs text-muted-foreground">“{answer.question}”</p>
            <p className={`mt-1 text-lg font-semibold ${answer.error ? "text-red-700" : ""}`}>{answer.text}</p>
            {!answer.error && (
              <a
                href={`/search?q=${encodeURIComponent(answer.clipQuery)}`}
                className="mt-1 inline-block text-xs text-brand-teal underline underline-offset-2"
              >
                View the matching clips →
              </a>
            )}
          </div>
        )}

        {/* Dashboard */}
        <div className="flex items-center gap-2">
          {WINDOWS.map((w) => (
            <button
              key={w.label}
              type="button"
              onClick={() => setHours(w.hours)}
              className={`rounded border px-2.5 py-1 text-xs transition-colors ${
                hours === w.hours
                  ? "border-brand-teal bg-brand-teal-soft text-brand-teal"
                  : "border-input bg-card text-muted-foreground hover:text-foreground"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>

        {loading && !stats ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : stats?.error ? (
          <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-700">
            Analytics unavailable — {stats.error}
          </div>
        ) : stats ? (
          <>
            <div className="rounded-lg border border-border bg-card p-4">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Total incidents</p>
              <p className="mt-1 text-3xl font-bold tabular-nums">{(stats.total ?? 0).toLocaleString()}</p>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="rounded-lg border border-border bg-card p-4">
                <p className="mb-3 text-sm font-semibold">By category</p>
                <Bars data={stats.byCategory} />
              </div>
              <div className="rounded-lg border border-border bg-card p-4">
                <p className="mb-3 text-sm font-semibold">By camera</p>
                <Bars data={stats.byCamera} />
              </div>
            </div>

            {(stats.byDay ?? []).length > 0 && (
              <div className="rounded-lg border border-border bg-card p-4">
                <p className="mb-3 text-sm font-semibold">By day</p>
                <div className="flex items-end gap-1" style={{ height: 80 }}>
                  {(stats.byDay ?? []).slice(-30).map((d) => (
                    <div
                      key={d.day}
                      title={`${d.day}: ${d.count}`}
                      className="flex-1 rounded-t bg-brand-teal"
                      style={{ height: `${dayMax > 0 ? (d.count / dayMax) * 100 : 0}%`, minHeight: 2 }}
                    />
                  ))}
                </div>
                <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
                  <span>{(stats.byDay ?? []).slice(-30)[0]?.day}</span>
                  <span>{(stats.byDay ?? [])[(stats.byDay ?? []).length - 1]?.day}</span>
                </div>
              </div>
            )}
          </>
        ) : null}
      </div>
    </Shell>
  );
}
