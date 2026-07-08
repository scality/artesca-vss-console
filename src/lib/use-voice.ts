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
   * Speak `text` via the browser's text-to-speech engine after stripping
   * markdown and agent reasoning blocks to plain prose. Optionally calls
   * `onEnd` when the utterance finishes (useful for hands-free conversation
   * mode: start listening again after the agent stops speaking).
   */
  speak: (text: string, onEnd?: () => void) => void;
  /** Cancel any in-progress or queued speech synthesis. */
  cancelSpeak: () => void;
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

  const speak = useCallback((text: string, onEnd?: () => void): void => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const plain = stripMarkdownForSpeech(text);
    if (!plain) return;
    const utterance = new SpeechSynthesisUtterance(plain);
    if (onEnd) utterance.onend = onEnd;
    window.speechSynthesis.speak(utterance);
  }, []);

  const cancelSpeak = useCallback((): void => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }, []);

  return { supported, listening, startListening, stopListening, speak, cancelSpeak };
}
