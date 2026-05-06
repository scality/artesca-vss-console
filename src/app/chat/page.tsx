"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, CheckCircle2, Loader2, Send, User, Video, XCircle } from "lucide-react";
import { Shell } from "@/components/Shell";

type Role = "user" | "assistant" | "system";
type Message = { role: Role; content: string; ts: string };

type CameraFeed = { vstRegistered?: boolean; rtspUrl?: string };
type Camera = { id: string; description?: string; feeds?: CameraFeed[] };

const STORAGE_KEY = "nvidia-vss-chat-history";
const SCOPE_KEY = "nvidia-vss-chat-scope";
const SCOPE_ALL = "__all__";

const G4A_PROBE_QUERY =
  "What activity has been recorded most recently? Give a brief summary.";

type G4aState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "pass"; note: string }
  | { phase: "fail"; reason: string };

/**
 * Strip the upstream agent's <agent-think> reasoning blocks from rendered
 * output — they're useful for debugging but noisy for showroom operators.
 * Toggle via the "show reasoning" switch below the input.
 */
function stripReasoning(content: string): string {
  return content
    .replace(/<agent-think>[\s\S]*?<\/agent-think>/g, "")
    .replace(/<agent-think-step[^>]*>[\s\S]*?<\/agent-think-step>/g, "")
    .trim();
}

/** Returns true when the upstream NVIDIA nvidia-vss-agent returned its canned
 *  "something went wrong internally" fallback. The agent emits this when
 *  the underlying workflow (LLM call, tool use, knowledge graph lookup)
 *  raises an unhandled exception — the bare text gives no hint as to
 *  which subsystem failed, so the chat UI surfaces a debugging card. */
const CANNED_FAILURE_PATTERN =
  /sorry,?\s*I (wasn'?t able|was unable) to complete your request/i;

function isCannedFailure(content: string): boolean {
  return CANNED_FAILURE_PATTERN.test(stripReasoning(content));
}

function hasReasoning(content: string): boolean {
  return content.length !== stripReasoning(content).length;
}

type ReasoningStep = { title: string; body: string };

function parseReasoning(content: string): { steps: ReasoningStep[]; answer: string } {
  const steps: ReasoningStep[] = [];
  const re = /<agent-think-step[^>]*title="([^"]*)"[^>]*>([\s\S]*?)<\/agent-think-step>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    steps.push({ title: m[1], body: m[2].trim() });
  }
  return { steps, answer: stripReasoning(content) };
}

function ReasoningBlock({ steps }: { steps: ReasoningStep[] }) {
  return (
    <div className="mb-2 rounded border border-slate-700 bg-slate-900/60 text-[11px]">
      <div className="border-b border-slate-700 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-slate-500">
        agent reasoning · {steps.length} step{steps.length !== 1 ? "s" : ""}
      </div>
      {steps.map((s, i) => {
        const isToolCall = /tool call/i.test(s.title);
        return (
          <div
            key={i}
            className={`border-b border-slate-800 px-2 py-1.5 last:border-0 ${isToolCall ? "bg-indigo-950/20" : ""}`}
          >
            <div
              className={`mb-0.5 font-mono text-[10px] uppercase tracking-wide ${
                isToolCall ? "text-indigo-400" : "text-slate-500"
              }`}
            >
              {s.title}
            </div>
            <div className="whitespace-pre-wrap break-words text-slate-400">{s.body}</div>
          </div>
        );
      })}
    </div>
  );
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showReasoning, setShowReasoning] = useState(false);
  const [cameras, setCameras] = useState<Camera[] | null>(null);
  const [scope, setScope] = useState<string>(SCOPE_ALL);
  const [g4a, setG4a] = useState<G4aState>({ phase: "idle" });
  const scrollRef = useRef<HTMLDivElement>(null);

  // Restore history + scope on mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setMessages(JSON.parse(raw) as Message[]);
      const savedScope = localStorage.getItem(SCOPE_KEY);
      if (savedScope) setScope(savedScope);
    } catch {
      /* ignore */
    }
  }, []);

  // Load cameras list — refresh every 30s so newly-registered streams show up.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/cameras", { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as { cameras?: Camera[] };
        if (alive) setCameras(j.cameras ?? []);
      } catch {
        /* ignore — selector will show "no cameras" */
      }
    };
    void load();
    const h = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, []);

  // Persist scope.
  useEffect(() => {
    try {
      localStorage.setItem(SCOPE_KEY, scope);
    } catch {
      /* quota */
    }
  }, [scope]);

  // Resolve scope → camera record for hint rendering + system-message context.
  const scopedCamera = useMemo(
    () => (scope === SCOPE_ALL ? null : cameras?.find((c) => c.id === scope) ?? null),
    [scope, cameras],
  );
  const liveCount = useMemo(
    () => cameras?.filter((c) => c.feeds?.some((f) => f.vstRegistered)).length ?? 0,
    [cameras],
  );

  // Persist history.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    } catch {
      /* quota */
    }
  }, [messages]);

  // Auto-scroll on new message.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  async function runG4aProbe() {
    setG4a({ phase: "running" });
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: G4A_PROBE_QUERY }] }),
      });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);
      const reply: string = j?.choices?.[0]?.message?.content ?? "";
      const clean = stripReasoning(reply);
      if (!clean || clean.length < 30 || isCannedFailure(reply)) {
        setG4a({
          phase: "fail",
          reason: clean
            ? `Response too short or indicates internal failure (${clean.length} chars)`
            : "Empty response from agent",
        });
        return;
      }
      setG4a({ phase: "pass", note: clean.slice(0, 160).replace(/\n/g, " ") });
      // Append probe exchange to chat history so the operator sees what was asked.
      setMessages((prev) => [
        ...prev,
        { role: "user", content: `[G4a probe] ${G4A_PROBE_QUERY}`, ts: new Date().toISOString() },
        { role: "assistant", content: reply, ts: new Date().toISOString() },
      ]);
    } catch (e) {
      setG4a({ phase: "fail", reason: (e as Error).message });
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    const userMsg: Message = { role: "user", content: text, ts: new Date().toISOString() };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput("");
    setLoading(true);
    setError(null);
    try {
      // Build the request payload. When scoped to a specific camera, inject
      // the sensor name directly into the last user message so the agent's
      // tool router acts on it immediately (system messages alone are ignored
      // by the agent's top_agent pipeline which calls get_sensor_names first).
      // The displayed transcript uses the original text; only the wire payload
      // carries the camera suffix.
      const wireMessages = next.map(({ role, content }, idx) => {
        if (
          scopedCamera != null &&
          role === "user" &&
          idx === next.length - 1 &&
          !content.toLowerCase().includes(scopedCamera.id.toLowerCase())
        ) {
          return { role, content: `${content} (sensor: ${scopedCamera.id})` };
        }
        return { role, content };
      });
      const wirePayload = wireMessages;
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: wirePayload }),
      });
      const j = await res.json();
      if (!res.ok || j.error) {
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const reply = j?.choices?.[0]?.message?.content;
      if (typeof reply !== "string") {
        throw new Error("malformed agent response (no choices[0].message.content)");
      }
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: reply, ts: new Date().toISOString() },
      ]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function clear() {
    setMessages([]);
    setError(null);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  return (
    <Shell>
      <div className="flex h-[calc(100vh-4rem)] flex-col gap-3 p-4">
        <header className="flex items-baseline justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
              <Bot className="h-5 w-5 text-emerald-400" />
              VSS Chat
            </h1>
            <p className="text-xs text-slate-500">
              Talk to the cosmos-reason2-8b VLM via nvidia-vss-agent. The agent has access to
              every registered camera + recent recordings.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-[11px] font-mono text-slate-400">
              <input
                type="checkbox"
                checked={showReasoning}
                onChange={(e) => setShowReasoning(e.target.checked)}
                className="accent-emerald-500"
              />
              show reasoning
            </label>
            <button
              onClick={() => void runG4aProbe()}
              disabled={loading || g4a.phase === "running"}
              className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[11px] font-mono transition-colors disabled:opacity-50 ${
                g4a.phase === "pass"
                  ? "border-emerald-700 bg-emerald-950/40 text-emerald-300"
                  : g4a.phase === "fail"
                  ? "border-rose-700 bg-rose-950/40 text-rose-300"
                  : "border-slate-700 bg-slate-900 text-slate-400 hover:text-slate-100"
              }`}
              title="Fire a standard G4a probe query and check the agent responds coherently"
            >
              {g4a.phase === "running" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : g4a.phase === "pass" ? (
                <CheckCircle2 className="h-3 w-3" />
              ) : g4a.phase === "fail" ? (
                <XCircle className="h-3 w-3" />
              ) : null}
              {g4a.phase === "running"
                ? "probing…"
                : g4a.phase === "pass"
                ? "G4a pass"
                : g4a.phase === "fail"
                ? "G4a fail"
                : "verify G4a"}
            </button>
            <button
              onClick={clear}
              disabled={messages.length === 0}
              className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-400 hover:text-slate-100 disabled:opacity-50"
            >
              clear
            </button>
            <button
              onClick={() =>
                window.open(
                  `${window.location.protocol}//${window.location.hostname}:3000`,
                  "_blank",
                  "noopener,noreferrer",
                )
              }
              className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-400 hover:text-slate-100"
              title="Open the upstream NVIDIA VSS UI (metropolis-vss-ui on port 3000)"
            >
              open upstream UI →
            </button>
          </div>
        </header>

        {g4a.phase === "pass" && (
          <div className="flex items-start gap-2 rounded border border-emerald-800 bg-emerald-950/30 px-3 py-2 text-[11px] text-emerald-300">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>
              <span className="font-semibold font-mono">G4a — agent answered coherently.</span>
              <span className="ml-2 text-emerald-400/80">{g4a.note}…</span>
            </div>
            <button onClick={() => setG4a({ phase: "idle" })} className="ml-auto shrink-0 opacity-50 hover:opacity-100 text-xs">✕</button>
          </div>
        )}
        {g4a.phase === "fail" && (
          <div className="flex items-start gap-2 rounded border border-rose-800 bg-rose-950/30 px-3 py-2 text-[11px] text-rose-300">
            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>
              <span className="font-semibold font-mono">G4a — probe failed.</span>
              <span className="ml-2 font-mono">{g4a.reason}</span>
            </div>
            <button onClick={() => setG4a({ phase: "idle" })} className="ml-auto shrink-0 opacity-50 hover:opacity-100 text-xs">✕</button>
          </div>
        )}

        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/50 p-3 text-sm"
        >
          {messages.length === 0 && (
            <div className="flex h-full items-center justify-center text-center text-slate-600">
              <div>
                <Bot className="mx-auto mb-2 h-8 w-8 text-slate-700" />
                <div>Ask the VLM something about the cameras or recent events.</div>
                <div className="mt-1 text-xs">
                  e.g. <span className="font-mono text-slate-500">how many cameras are streaming?</span>
                </div>
              </div>
            </div>
          )}
          {messages.map((m, i) => {
            const { steps, answer } = m.role === "assistant"
              ? parseReasoning(m.content)
              : { steps: [], answer: m.content };
            const display = showReasoning ? answer : stripReasoning(m.content);
            const cannedFailure = m.role === "assistant" && isCannedFailure(m.content);
            const hasReasoningBlocks = m.role === "assistant" && hasReasoning(m.content);
            return (
              <div key={i} className="mb-4 flex gap-3">
                <div className="shrink-0">
                  {m.role === "user" ? (
                    <User className="h-5 w-5 text-sky-400" />
                  ) : (
                    <Bot className="h-5 w-5 text-emerald-400" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] uppercase tracking-wider text-slate-500">
                    {m.role}
                  </div>
                  {showReasoning && steps.length > 0 && <ReasoningBlock steps={steps} />}
                  <div className="mt-0.5 whitespace-pre-wrap break-words text-slate-100">
                    {display || (
                      <span className="italic text-slate-500">(empty after stripping reasoning)</span>
                    )}
                  </div>
                  {cannedFailure && (
                    <div className="mt-2 rounded border border-amber-800 bg-amber-950/40 p-2 text-[11px] text-amber-300">
                      <div className="font-semibold">Upstream agent fallback — workflow failed internally.</div>
                      <div className="mt-1 text-amber-300/80">
                        Common causes: cosmos-reason NIM not warmed up · no cameras registered with VST ·
                        knowledge-graph empty · LLM tool call timed out. Check{" "}
                        <code className="rounded bg-slate-800 px-1 text-amber-200">docker compose logs nvidia-vss-agent</code>{" "}
                        on the workspace.
                        {hasReasoningBlocks && !showReasoning && (
                          <> Toggle <span className="font-mono text-amber-200">show reasoning</span> above to see the agent&apos;s internal trace.</>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {loading && (
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              nvidia-vss-agent is thinking…
            </div>
          )}
        </div>

        {error && (
          <div className="rounded border border-rose-800 bg-rose-950/40 p-2 text-xs font-mono text-rose-300">
            {error}
          </div>
        )}

        <div className="flex items-center gap-3 text-[11px] text-slate-400">
          <label className="flex items-center gap-1.5">
            <Video className="h-3.5 w-3.5 text-slate-500" />
            <span className="uppercase tracking-wide text-[10px]">Scope</span>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-[11px] text-slate-200 hover:border-slate-500 focus:border-emerald-700 focus:outline-none"
              disabled={loading}
              title="Restrict the agent to a specific camera. Pick 'All cameras' to query the whole fleet."
            >
              <option value={SCOPE_ALL}>
                All cameras{cameras ? ` (${cameras.length} registered, ${liveCount} live)` : ""}
              </option>
              {(cameras ?? []).map((c) => {
                const live = c.feeds?.some((f) => f.vstRegistered) ? "● " : "○ ";
                return (
                  <option key={c.id} value={c.id}>
                    {live}
                    {c.id}
                    {c.description ? ` — ${c.description}` : ""}
                  </option>
                );
              })}
            </select>
          </label>
          {cameras !== null && cameras.length === 0 && (
            <span className="italic text-slate-600">
              No cameras registered — use{" "}
              <a href="/cameras" className="underline hover:text-slate-300">
                /cameras
              </a>{" "}
              to add one.
            </span>
          )}
          {scopedCamera && (
            <span className="text-emerald-400">
              Asking about <span className="font-mono">{scopedCamera.id}</span>
            </span>
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className="flex gap-2"
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Ask nvidia-vss-agent…  (Enter to send, Shift+Enter for newline)"
            rows={2}
            className="flex-1 resize-y rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-emerald-700 focus:outline-none"
            disabled={loading}
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="flex shrink-0 items-center gap-1.5 self-stretch rounded border border-emerald-700 bg-emerald-950/40 px-4 text-sm text-emerald-300 hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send className="h-4 w-4" />
            Send
          </button>
        </form>
      </div>
    </Shell>
  );
}
