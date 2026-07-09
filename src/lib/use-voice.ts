"use client";

import { useCallback, useRef, useState } from "react";

/**
 * Strip markdown and agent reasoning blocks to plain speakable text.
 * TTS should never read markdown artifacts like **bold**, [Watch clip](url),
 * ![snapshot](url), table pipes, headings, or reasoning block XML.
 */
export function stripMarkdownForSpeech(text: string): string {
  return text
    // Agent reasoning blocks (XML tags used by vss-agent)
    .replace(/<agent-think>[\s\S]*?<\/agent-think>/g, "")
    .replace(/<agent-think-step[^>]*>[\s\S]*?<\/agent-think-step>/g, "")
    // Generic HTML tags
    .replace(/<[^>]+>/g, "")
    // Images — no audio value, drop entirely
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    // Links — keep only link text (never read the URL)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    // Fenced code blocks — drop content (not meaningful spoken aloud)
    .replace(/```[\s\S]*?```/g, "")
    // Bold / italic / strikethrough markers
    .replace(/\*{1,3}([^*\n]+)\*{1,3}/g, "$1")
    .replace(/_{1,3}([^_\n]+)_{1,3}/g, "$1")
    .replace(/~~([^~\n]+)~~/g, "$1")
    // Inline code — keep content, drop backticks
    .replace(/`([^`]+)`/g, "$1")
    // ATX headings — keep heading text, drop the # markers
    .replace(/^#{1,6}\s+/gm, "")
    // Table pipes — turn column separators into pauses (spaces)
    .replace(/\|/g, " ")
    // Collapse multiple blank lines → a single sentence pause
    .replace(/\n{2,}/g, ". ")
    // Remaining newlines → space
    .replace(/\n/g, " ")
    // Normalise runs of whitespace
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Choose the best available English text-to-speech voice.
 *
 * The browser's default voice is whatever the OS picks — on a non-US machine
 * that is frequently a foreign-locale or low-quality "compact" voice, which
 * mangles English. Prefer a known high-quality English voice, then any en-US
 * non-compact voice, then any English voice, and only fall back to the default.
 */
/**
 * Prime the speech-synthesis voice list. In Chrome getVoices() is empty until
 * the engine fires `voiceschanged` once; calling it early (at module load)
 * warms the cache so the first spoken reply already gets a good English voice
 * instead of the raw system default.
 */
function warmVoices(): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.getVoices();
    window.speechSynthesis.addEventListener?.("voiceschanged", () => {
      window.speechSynthesis.getVoices();
    });
  } catch {
    // best-effort
  }
}
warmVoices();

export function pickEnglishVoice(): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;

  const english = voices.filter((v) => /^en([-_]|$)/i.test(v.lang));
  const pool = english.length ? english : voices;

  const preferred = [
    "Google US English",
    "Samantha",
    "Microsoft Aria",
    "Microsoft Jenny",
    "Google UK English Female",
    "Google UK English Male",
    "Daniel",
  ];
  for (const name of preferred) {
    const match = pool.find((v) => v.name === name || v.name.includes(name));
    if (match) return match;
  }

  const usNatural = pool.find((v) => /en[-_]US/i.test(v.lang) && !/compact/i.test(v.name));
  return usNatural || pool.find((v) => !/compact/i.test(v.name)) || pool[0];
}

// ── Web Speech API type declarations ─────────────────────────────────────────
//
// SpeechRecognition (STT) and SpeechRecognitionEvent are experimental APIs
// that TypeScript's standard lib.dom.d.ts does not fully declare. We define
// minimal local interfaces for the subset the hook uses so we don't need
// a third-party @types package or a global ambient d.ts file.

interface ISpeechRecognitionEvent {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface ISpeechRecognition extends EventTarget {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onstart: (() => void) | null;
  onresult: ((event: ISpeechRecognitionEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionCtor = new () => ISpeechRecognition;

declare global {
  interface Window {
    // Standard name (Firefox, future Chrome)
    SpeechRecognition?: SpeechRecognitionCtor;
    // Vendor-prefixed name (current Chrome / Edge)
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface SpeakOptions {
  /** Called when the utterance/clip finishes (used for hands-free loop). */
  onEnd?: () => void;
  /**
   * Which TTS engine to use:
   * - "browser" (default): the Web Speech synthesis engine, client-side.
   * - "nim": the on-box NVIDIA Magpie TTS NIM via the /api/tts proxy. Falls
   *   back to the browser engine on any fetch/playback failure.
   */
  engine?: "browser" | "nim";
  /** browser engine: a specific voice URI to use (else the best English auto-pick). */
  browserVoiceURI?: string;
  /** nim engine: the on-box voice name (e.g. "Magpie-Multilingual.EN-US.Aria"). */
  nimVoice?: string;
  /** browser engine playback rate (0.1–10, default 1.0). */
  rate?: number;
}

export interface UseVoiceResult {
  /** True only when BOTH SpeechRecognition AND speechSynthesis are available. */
  supported: boolean;
  /** True while STT is active and listening for speech. */
  listening: boolean;
  /**
   * Start speech-to-text. Calls `onFinal(transcript)` when the user stops
   * speaking and a final result is available. Only one recognition session
   * runs at a time; any active session is aborted before starting a new one.
   */
  startListening: (onFinal: (text: string) => void) => void;
  /** Stop the active recognition session (if any). */
  stopListening: () => void;
  /**
   * Speak `text` after stripping markdown/agent-reasoning to plain prose.
   * Second arg is either SpeakOptions or (back-compat) a bare onEnd callback.
   */
  speak: (text: string, opts?: SpeakOptions | (() => void)) => void;
  /** Cancel any in-progress speech (browser synthesis AND on-box clip playback). */
  cancelSpeak: () => void;
  /** The browser's available synthesis voices (may be empty until warmed). */
  listBrowserVoices: () => SpeechSynthesisVoice[];
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useVoice(): UseVoiceResult {
  // Feature-detect once at initialisation time. The lazy initializer runs
  // during render (not in an effect) so there is no setState-in-effect and
  // no extra re-render. On the server window is undefined → false; on the
  // client the real value is computed before first paint.
  const [supported] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    const RecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    return !!RecognitionCtor && "speechSynthesis" in window;
  });
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<ISpeechRecognition | null>(null);
  // Current on-box (NIM) audio element, so cancelSpeak can stop it too.
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const startListening = useCallback((onFinal: (text: string) => void): void => {
    if (typeof window === "undefined") return;
    const RecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!RecognitionCtor) return;

    // Abort any active session before starting a new one.
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {
        // Ignore — abort is best-effort.
      }
    }

    const recognition = new RecognitionCtor();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.continuous = false;

    recognition.onstart = () => setListening(true);

    recognition.onresult = (event: ISpeechRecognitionEvent) => {
      let finalTranscript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        }
      }
      if (finalTranscript.trim()) {
        onFinal(finalTranscript.trim());
      }
    };

    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);

    recognitionRef.current = recognition;
    recognition.start();
  }, []);

  const stopListening = useCallback((): void => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Ignore.
      }
    }
    setListening(false);
  }, []);

  const stopAudio = useCallback((): void => {
    const a = audioRef.current;
    if (a) {
      try {
        a.pause();
        if (a.src) URL.revokeObjectURL(a.src);
        a.src = "";
      } catch {
        // best-effort
      }
      audioRef.current = null;
    }
  }, []);

  const speak = useCallback(
    (text: string, opts?: SpeakOptions | (() => void)): void => {
      if (typeof window === "undefined") return;
      const o: SpeakOptions = typeof opts === "function" ? { onEnd: opts } : opts ?? {};
      const plain = stripMarkdownForSpeech(text);
      if (!plain) return;

      // Browser (Web Speech) synthesis — also the fallback for the NIM path.
      const speakBrowser = () => {
        if (!("speechSynthesis" in window)) return;
        const utterance = new SpeechSynthesisUtterance(plain);
        // Pin English + a good voice; the SYSTEM DEFAULT is often a
        // foreign-locale/compact voice that mangles English.
        utterance.lang = "en-US";
        const chosen =
          (o.browserVoiceURI &&
            window.speechSynthesis
              .getVoices()
              .find((v) => v.voiceURI === o.browserVoiceURI)) ||
          pickEnglishVoice();
        if (chosen) utterance.voice = chosen;
        utterance.rate = o.rate ?? 1.0;
        utterance.pitch = 1.0;
        if (o.onEnd) utterance.onend = o.onEnd;
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utterance);
      };

      if (o.engine === "nim") {
        // On-box NVIDIA Magpie TTS via the console proxy. Returns a WAV clip we
        // play through an <audio> element. Any failure → browser fallback so a
        // NIM outage never leaves the operator without a spoken reply.
        if ("speechSynthesis" in window) window.speechSynthesis.cancel();
        stopAudio();
        const body = JSON.stringify({ text: plain, voice: o.nimVoice });
        fetch("/api/tts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        })
          .then(async (r) => {
            if (!r.ok) throw new Error(`tts ${r.status}`);
            const blob = await r.blob();
            if (!blob.size) throw new Error("empty audio");
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            audioRef.current = audio;
            audio.onended = () => {
              URL.revokeObjectURL(url);
              audioRef.current = null;
              o.onEnd?.();
            };
            audio.onerror = () => {
              URL.revokeObjectURL(url);
              audioRef.current = null;
              speakBrowser();
            };
            await audio.play();
          })
          .catch(() => speakBrowser());
        return;
      }

      speakBrowser();
    },
    [stopAudio],
  );

  const cancelSpeak = useCallback((): void => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    stopAudio();
  }, [stopAudio]);

  const listBrowserVoices = useCallback((): SpeechSynthesisVoice[] => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return [];
    return window.speechSynthesis.getVoices();
  }, []);

  return {
    supported,
    listening,
    startListening,
    stopListening,
    speak,
    cancelSpeak,
    listBrowserVoices,
  };
}
