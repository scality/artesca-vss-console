"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, CheckCircle2, Loader2, Mic, MicOff, Play, Send, User, Video, Volume2, XCircle } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Shell } from "@/components/Shell";
import { useVoice, stripMarkdownForSpeech } from "@/lib/use-voice";

type Role = "user" | "assistant" | "system";
type Message = { role: Role; content: string; ts: string };

type CameraFeed = { vstRegistered?: boolean; rtspUrl?: string };
type Camera = { id: string; description?: string; feeds?: CameraFeed[] };

const STORAGE_KEY = "nvidia-vss-chat-history";
const SCOPE_KEY = "nvidia-vss-chat-scope";
const CONVERSATION_KEY = "nvidia-vss-chat-conversation-id";
const VOICE_KEY = "nvidia-vss-chat-voice";
const SCOPE_ALL = "__all__";

/** Parse a voice-selector value ("browser:<uri>" | "nim:<name>") into speak() opts. */
function parseVoiceChoice(choice: string): {
  engine: "browser" | "nim";
  browserVoiceURI?: string;
  nimVoice?: string;
} {
  if (choice.startsWith("nim:")) return { engine: "nim", nimVoice: choice.slice(4) };
  const uri = choice.startsWith("browser:") ? choice.slice(8) : "";
  return { engine: "browser", browserVoiceURI: uri || undefined };
}

/** "Magpie-Multilingual.EN-US.Aria" → "Aria" for a compact dropdown label. */
function shortVoiceName(name: string): string {
  const parts = name.split(".");
  return parts[parts.length - 1] || name;
}

// Stable per-conversation id sent as the `conversation-id` header (via /api/chat)
// so the agent threads follow-up references ("it", "the clip", "yes") across
// turns — the agent keys its server-side history by this, not the client
// message array. Persisted so a reload continues the same conversation; cleared
// (→ new id) when the operator clears the chat.
function ensureConversationId(): string {
  try {
    let id = localStorage.getItem(CONVERSATION_KEY);
    if (!id) {
      id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `conv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(CONVERSATION_KEY, id);
    }
    return id;
  } catch {
    return "console-chat";
  }
}

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

/** Returns true when the upstream NVIDIA vss-agent returned its canned
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

/**
 * Only http(s) or same-origin relative URLs are safe to render into a
 * src/href. Chat content is LLM/VLM output (attacker-influenceable via
 * camera feeds), so a javascript:/data: URL here would be XSS on click.
 */
const SAFE_URL_PATTERN = /^(https?:\/\/|\/)/i;
function isSafeUrl(url: string | undefined): url is string {
  return typeof url === "string" && SAFE_URL_PATTERN.test(url.trim());
}

/** Anchors pointing at a clip file render as an inline <video> instead of a link. */
const VIDEO_URL_PATTERN = /\.(mp4|webm|mov)(\?|$)/i;

/**
 * Recorded-clip-frame still for a clip URL. The upstream VST still-image
 * endpoint (vst_snapshot / .../picture/url) is broken cluster-wide ("Failed
 * to start source producer") and stays bypassed by design — the agent only
 * ever emits clip links, never snapshot links. Every still shown in chat is
 * instead extracted server-side from the clip's own recorded frame via
 * /api/media-thumb (ffmpeg first-frame extraction — the same mechanism
 * /api/clips/[sensor]/[ts]/thumb uses). Used both as a <video poster> (a real
 * still shows immediately, before/without playing) and as the <img> src when
 * the reply is an explicit ![snapshot](...) pointing at a video file.
 */
function mediaThumbUrl(clipUrl: string): string {
  return `/api/media-thumb?src=${encodeURIComponent(clipUrl)}`;
}

/**
 * Picture-first clip renderer: shows the recorded-frame still by default
 * (via /api/media-thumb) with a play affordance overlaid, and only mounts a
 * <video> — loading/playing the actual clip — once the operator clicks.
 * Without this, every clip link renders as a <video controls poster=…> up
 * front, which operators read as "a video clip" rather than "a picture".
 */
function ClipStill({ clipUrl, alt }: { clipUrl: string; alt?: string }) {
  const [play, setPlay] = useState(false);

  if (play) {
    return (
      <video
        src={clipUrl}
        controls
        autoPlay
        playsInline
        preload="metadata"
        poster={mediaThumbUrl(clipUrl)}
        className="mt-2 block w-full max-w-md max-h-80 rounded border border-border bg-black object-contain"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setPlay(true)}
      className="group relative mt-2 block w-full max-w-md text-left"
      aria-label="Play clip"
    >
      <img
        src={mediaThumbUrl(clipUrl)}
        alt={alt || "snapshot"}
        className="block w-full max-w-md rounded border border-border"
      />
      <span className="absolute inset-0 flex items-center justify-center rounded transition-colors group-hover:bg-black/10">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-black/60 text-white transition-transform group-hover:scale-110 group-hover:bg-black/70">
          <Play className="h-5 w-5 fill-white" />
        </span>
      </span>
    </button>
  );
}

/**
 * Custom react-markdown renderers: the agent's reply is real markdown
 * (**bold**, lists, headings, tables — plus ![alt](url) for snapshots and
 * [text](url) for clips). With /api/chat/route.ts rewriting the agent's
 * browser-unreachable media host to the console's own /api/media proxy, the
 * img/a overrides below turn those links into a clickable image/still or a
 * real <img> — the reply "just works" on click. Every element carries
 * theme-matched Tailwind classes since no typography plugin is installed.
 */
const markdownComponents: Components = {
  img({ src, alt }) {
    // react-markdown's experimental img typings widen `src` beyond string;
    // remark/rehype only ever emit a string URL from `![alt](url)`, so
    // narrow explicitly rather than loosen the shared isSafeUrl guard.
    const url = typeof src === "string" ? src : undefined;
    if (!isSafeUrl(url)) return <>{alt || url || ""}</>;
    // An explicit ![snapshot](url) is a STILL — render a plain image with NO
    // play control, so it reads as a picture, distinct from a [clip](url) link
    // (which renders as a picture-first still WITH a play affordance). When the
    // snapshot points at a clip file, show its extracted recorded frame via
    // /api/media-thumb (no browser decodes an mp4 as an <img>).
    const stillSrc = VIDEO_URL_PATTERN.test(url) ? mediaThumbUrl(url) : url;
    return (
      <img
        src={stillSrc}
        alt={alt || "snapshot"}
        loading="lazy"
        className="mt-2 block w-full max-w-md rounded border border-border"
      />
    );
  },
  a({ href, children }) {
    if (!isSafeUrl(href)) return <>{children}</>;
    if (VIDEO_URL_PATTERN.test(href)) {
      return <ClipStill clipUrl={href} />;
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-brand-teal underline underline-offset-2 hover:text-brand-teal/80"
      >
        {children}
      </a>
    );
  },
  p({ children }) {
    return <p className="mb-2 leading-relaxed last:mb-0">{children}</p>;
  },
  strong({ children }) {
    return <strong className="font-semibold">{children}</strong>;
  },
  em({ children }) {
    return <em className="italic">{children}</em>;
  },
  ul({ children }) {
    return <ul className="mb-2 list-disc space-y-0.5 pl-5 last:mb-0">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="mb-2 list-decimal space-y-0.5 pl-5 last:mb-0">{children}</ol>;
  },
  li({ children }) {
    return <li className="leading-relaxed">{children}</li>;
  },
  h1({ children }) {
    return <h1 className="mb-1.5 mt-2 text-base font-semibold first:mt-0">{children}</h1>;
  },
  h2({ children }) {
    return <h2 className="mb-1.5 mt-2 text-[15px] font-semibold first:mt-0">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="mb-1 mt-2 text-sm font-semibold first:mt-0">{children}</h3>;
  },
  code({ className, children }) {
    // Fenced code blocks carry a `language-*` className from remark/rehype;
    // inline `code` spans don't — style each case distinctly so a fenced
    // block's <code> doesn't fight the wrapping <pre>'s own background.
    if (/language-/.test(className ?? "")) {
      return <code className={`${className ?? ""} font-mono text-sm`}>{children}</code>;
    }
    return <code className="rounded bg-muted px-1 font-mono text-sm">{children}</code>;
  },
  pre({ children }) {
    return <pre className="mt-2 overflow-x-auto rounded bg-muted p-2">{children}</pre>;
  },
  table({ children }) {
    return (
      <div className="mt-2 overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">{children}</table>
      </div>
    );
  },
  th({ children }) {
    return <th className="border border-border bg-muted px-2 py-1 font-semibold">{children}</th>;
  },
  td({ children }) {
    return <td className="border border-border px-2 py-1 align-top">{children}</td>;
  },
};

function ReasoningBlock({ steps }: { steps: ReasoningStep[] }) {
  return (
    <div className="mb-2 rounded border border-brand-light-gray bg-muted text-[11px]">
      <div className="border-b border-brand-light-gray px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        agent reasoning · {steps.length} step{steps.length !== 1 ? "s" : ""}
      </div>
      {steps.map((s, i) => {
        const isToolCall = /tool call/i.test(s.title);
        return (
          <div
            key={i}
            className={`border-b border-brand-light-gray px-2 py-1.5 last:border-0 ${isToolCall ? "bg-accent" : ""}`}
          >
            <div
              className={`mb-0.5 font-mono text-[10px] uppercase tracking-wide ${
                isToolCall ? "text-brand-indigo" : "text-muted-foreground"
              }`}
            >
              {s.title}
            </div>
            <div className="whitespace-pre-wrap break-words text-foreground">{s.body}</div>
          </div>
        );
      })}
    </div>
  );
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as Message[]) : [];
    } catch {
      return [];
    }
  });
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showReasoning, setShowReasoning] = useState(false);
  const [cameras, setCameras] = useState<Camera[] | null>(null);
  const [scope, setScope] = useState<string>(() => {
    if (typeof window === "undefined") return SCOPE_ALL;
    try {
      return localStorage.getItem(SCOPE_KEY) ?? SCOPE_ALL;
    } catch {
      return SCOPE_ALL;
    }
  });
  const [g4a, setG4a] = useState<G4aState>({ phase: "idle" });
  const [conversationMode, setConversationMode] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Voice — STT + TTS. TTS engine is operator-selectable: browser Web Speech
  // voices or the on-box NVIDIA Magpie NIM (via /api/tts), with browser fallback.
  const voice = useVoice();
  const { listBrowserVoices, supported: voiceSupported } = voice;
  const [voiceChoice, setVoiceChoice] = useState<string>(() => {
    if (typeof window === "undefined") return "browser:";
    try {
      return localStorage.getItem(VOICE_KEY) ?? "browser:";
    } catch {
      return "browser:";
    }
  });
  const [browserVoices, setBrowserVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [onboxTts, setOnboxTts] = useState<{ available: boolean; voices: string[] }>({
    available: false,
    voices: [],
  });
  // Tracks whether the last send() originated from a voice input so the reply is spoken.
  const voiceOriginatedRef = useRef(false);
  // Stable ref to always call the latest send() from async TTS/STT callbacks.
  const sendRef = useRef<((textOverride?: string) => Promise<void>) | null>(null);

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

  // Persist the selected TTS voice.
  useEffect(() => {
    try {
      localStorage.setItem(VOICE_KEY, voiceChoice);
    } catch {
      /* quota */
    }
  }, [voiceChoice]);

  // Load the browser's English voices (refresh on voiceschanged — Chrome loads async).
  useEffect(() => {
    if (!voiceSupported) return;
    const load = () =>
      setBrowserVoices(listBrowserVoices().filter((v) => /^en/i.test(v.lang)));
    load();
    const synth = window.speechSynthesis;
    synth?.addEventListener?.("voiceschanged", load);
    return () => synth?.removeEventListener?.("voiceschanged", load);
  }, [voiceSupported, listBrowserVoices]);

  // Probe on-box TTS (Magpie NIM) availability + voices; omit the option if down.
  useEffect(() => {
    let alive = true;
    fetch("/api/tts/voices", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (alive && j?.available) {
          setOnboxTts({ available: true, voices: Array.isArray(j.voices) ? j.voices : [] });
        }
      })
      .catch(() => {
        /* on-box TTS simply won't be offered */
      });
    return () => {
      alive = false;
    };
  }, []);

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
        body: JSON.stringify({
          messages: [{ role: "user", content: G4A_PROBE_QUERY }],
          conversationId: ensureConversationId(),
        }),
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

  // Build a stable handler for kiosk conversation mode: after TTS ends, start
  // listening again. Uses sendRef to avoid capturing a stale send() closure.
  const handleVoiceInput = useCallback(() => {
    voice.startListening((t) => {
      setInput(t);
      voiceOriginatedRef.current = true;
      void sendRef.current?.(t);
    });
  }, [voice]);

  async function send(textOverride?: string) {
    const text = (textOverride ?? input).trim();
    if (!text || loading) return;
    const userMsg: Message = { role: "user", content: text, ts: new Date().toISOString() };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput("");
    setLoading(true);
    setError(null);
    const wasVoice = voiceOriginatedRef.current;
    voiceOriginatedRef.current = false;
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
        body: JSON.stringify({ messages: wirePayload, conversationId: ensureConversationId() }),
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
      // Speak the reply when the query came from voice input. If conversation
      // mode is on, re-start listening once the utterance finishes (hands-free
      // kiosk loop: speak → listen → speak → …).
      if (wasVoice) {
        const speakableReply = stripMarkdownForSpeech(reply);
        voice.speak(speakableReply, {
          ...parseVoiceChoice(voiceChoice),
          onEnd: conversationMode ? handleVoiceInput : undefined,
        });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // Keep sendRef pointing at the latest send() so the conversation-mode loop
  // (TTS onEnd → startListening → sendRef.current) always calls the most-current
  // closure. useEffect fires after render, well before TTS onEnd triggers.
  useEffect(() => {
    sendRef.current = send;
  });

  function clear() {
    setMessages([]);
    setError(null);
    try {
      localStorage.removeItem(STORAGE_KEY);
      // Start a fresh agent-side conversation thread on the next message so the
      // cleared transcript can't leak context into it.
      localStorage.removeItem(CONVERSATION_KEY);
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
              <Bot className="h-5 w-5 text-brand-teal" />
              VSS Chat
            </h1>
            <p className="text-xs text-muted-foreground">
              Talk to the VLM via vss-agent. The agent has access to
              every registered camera + recent recordings.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground">
              <input
                type="checkbox"
                checked={showReasoning}
                onChange={(e) => setShowReasoning(e.target.checked)}
                className="accent-emerald-500"
              />
              show reasoning
            </label>
            {voice.supported && (
              <label
                className="flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground"
                title="Conversation mode: automatically listen again after the agent replies (hands-free kiosk)"
              >
                <input
                  type="checkbox"
                  checked={conversationMode}
                  onChange={(e) => setConversationMode(e.target.checked)}
                  className="accent-brand-teal"
                />
                <Volume2 className="h-3 w-3" />
                conversation mode
              </label>
            )}
            <button
              onClick={() => void runG4aProbe()}
              disabled={loading || g4a.phase === "running"}
              className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[11px] font-mono transition-colors disabled:opacity-50 ${
                g4a.phase === "pass"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : g4a.phase === "fail"
                  ? "border-red-200 bg-red-50 text-brand-red"
                  : "border-input bg-card text-muted-foreground hover:text-foreground"
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
              className="rounded border border-input bg-card px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
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
              className="rounded border border-input bg-card px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
              title="Open the upstream NVIDIA VSS UI (metropolis-vss-ui on port 3000)"
            >
              open upstream UI →
            </button>
          </div>
        </header>

        {g4a.phase === "pass" && (
          <div className="flex items-start gap-2 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-700">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>
              <span className="font-semibold font-mono">G4a — agent answered coherently.</span>
              <span className="ml-2 text-emerald-600">{g4a.note}…</span>
            </div>
            <button onClick={() => setG4a({ phase: "idle" })} className="ml-auto shrink-0 opacity-50 hover:opacity-100 text-xs">✕</button>
          </div>
        )}
        {g4a.phase === "fail" && (
          <div className="flex items-start gap-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-brand-red">
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
          className="flex-1 overflow-y-auto rounded-lg border border-border bg-card p-3 text-sm"
        >
          {messages.length === 0 && (
            <div className="flex h-full items-center justify-center text-center text-muted-foreground">
              <div>
                <Bot className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
                <div>Ask the VLM something about the cameras or recent events.</div>
                <div className="mt-1 text-xs">
                  e.g. <span className="font-mono text-brand-slate">how many cameras are streaming?</span>
                </div>
                <div className="mt-0.5 text-xs">
                  or search the archive:{" "}
                  <span className="font-mono text-brand-slate">find every forklift incident</span>
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
                    <User className="h-5 w-5 text-brand-indigo" />
                  ) : (
                    <Bot className="h-5 w-5 text-brand-teal" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {m.role}
                  </div>
                  {showReasoning && steps.length > 0 && <ReasoningBlock steps={steps} />}
                  <div className="mt-0.5 whitespace-pre-line break-words text-foreground">
                    {display ? (
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                        {display}
                      </ReactMarkdown>
                    ) : (
                      <span className="italic text-muted-foreground">(empty after stripping reasoning)</span>
                    )}
                  </div>
                  {cannedFailure && (
                    <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-700">
                      <div className="font-semibold">Upstream agent fallback — workflow failed internally.</div>
                      <div className="mt-1 text-amber-600">
                        Common causes: NIM not warmed up · no cameras registered with VST ·
                        knowledge-graph empty · LLM tool call timed out. Check{" "}
                        <code className="rounded bg-muted px-1 text-amber-700">kubectl logs -n $VSS_NS -l app.kubernetes.io/name=vss-agent</code>{" "}
                        on the cluster.
                        {hasReasoningBlocks && !showReasoning && (
                          <> Toggle <span className="font-mono text-amber-700">show reasoning</span> above to see the agent&apos;s internal trace.</>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {loading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              vss-agent is thinking…
            </div>
          )}
        </div>

        {error && (
          <div className="rounded border border-red-200 bg-red-50 p-2 text-xs font-mono text-brand-red">
            {error}
          </div>
        )}

        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <label className="flex items-center gap-1.5">
            <Video className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="uppercase tracking-wide text-[10px]">Scope</span>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="rounded border border-input bg-card px-2 py-1 font-mono text-[11px] text-foreground hover:border-border focus:border-brand-teal focus:outline-none"
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
          {(voiceSupported || onboxTts.available) && (
            <label className="flex items-center gap-1.5" title="Which voice speaks the agent's replies">
              <Volume2 className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="uppercase tracking-wide text-[10px]">Voice</span>
              <select
                value={voiceChoice}
                onChange={(e) => setVoiceChoice(e.target.value)}
                className="rounded border border-input bg-card px-2 py-1 font-mono text-[11px] text-foreground hover:border-border focus:border-brand-teal focus:outline-none"
              >
                <option value="browser:">Browser — auto</option>
                {browserVoices.map((v) => (
                  <option key={v.voiceURI} value={`browser:${v.voiceURI}`}>
                    Browser — {v.name}
                  </option>
                ))}
                {onboxTts.available &&
                  onboxTts.voices.map((n) => (
                    <option key={n} value={`nim:${n}`}>
                      NVIDIA on-box — {shortVoiceName(n)}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {cameras !== null && cameras.length === 0 && (
            <span className="italic text-muted-foreground">
              No cameras registered — use{" "}
              <a href="/cameras" className="underline hover:text-foreground">
                /cameras
              </a>{" "}
              to add one.
            </span>
          )}
          {scopedCamera && (
            <span className="text-brand-teal">
              Asking about <span className="font-mono">{scopedCamera.id}</span>
            </span>
          )}
        </div>

        {voice.listening && (
          <div className="flex items-center gap-2 rounded border border-red-200 bg-red-50 px-3 py-1.5 text-[11px] font-mono text-red-600">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-500" />
            Listening… speak now, then pause.
            <button
              type="button"
              onClick={() => voice.stopListening()}
              className="ml-auto text-red-500 hover:text-red-700 underline"
            >
              cancel
            </button>
          </div>
        )}

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
            placeholder="Ask vss-agent…  (Enter to send, Shift+Enter for newline)"
            rows={2}
            className="flex-1 resize-y rounded border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-brand-teal focus:outline-none"
            disabled={loading}
          />
          {voice.supported && (
            <button
              type="button"
              disabled={loading}
              onClick={() => {
                if (voice.listening) {
                  voice.stopListening();
                } else {
                  voice.startListening((t) => {
                    setInput(t);
                    voiceOriginatedRef.current = true;
                    void send(t);
                  });
                }
              }}
              title={voice.listening ? "Stop listening" : "Speak your question (mic)"}
              className={`flex shrink-0 items-center gap-1.5 self-stretch rounded border px-3 text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                voice.listening
                  ? "border-red-300 bg-red-50 text-red-600 hover:bg-red-100"
                  : "border-input bg-card text-muted-foreground hover:text-foreground hover:border-border"
              }`}
            >
              {voice.listening ? (
                <MicOff className="h-4 w-4" />
              ) : (
                <Mic className="h-4 w-4" />
              )}
            </button>
          )}
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="flex shrink-0 items-center gap-1.5 self-stretch rounded border border-brand-teal bg-brand-teal-soft px-4 text-sm text-brand-teal hover:brightness-95 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send className="h-4 w-4" />
            Send
          </button>
        </form>
      </div>
    </Shell>
  );
}
