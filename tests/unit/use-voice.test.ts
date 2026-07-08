// @vitest-environment jsdom
/**
 * Unit tests for useVoice + stripMarkdownForSpeech.
 *
 * What is covered:
 *  1. stripMarkdownForSpeech — pure function, no DOM needed.
 *  2. useVoice — supported reflects presence of both APIs.
 *  3. useVoice — startListening wires onresult → onFinal(transcript).
 *  4. useVoice — speak calls speechSynthesis.speak with markdown-stripped text.
 *
 * Approach: we need jsdom for the hook (it calls window.* and uses React state),
 * but we test the hook through a minimal React harness component — same pattern
 * as topology-spinner-timeout.test.tsx — so we don't need @testing-library/react.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot } from "react-dom/client";
import React, { act, useEffect } from "react";
import { useVoice, stripMarkdownForSpeech, type UseVoiceResult } from "@/lib/use-voice";

// ── Mock SpeechRecognition ────────────────────────────────────────────────────
//
// Track the most-recently created instance so tests can fire its event handlers.
// We use a plain object type so we don't depend on the global SpeechRecognitionEvent.

interface FakeRecognitionEvent {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

let lastRecognition: MockRecognition | null = null;

class MockRecognition {
  lang = "";
  interimResults = false;
  continuous = false;
  onstart: (() => void) | null = null;
  onresult: ((event: FakeRecognitionEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn(() => {
    this.onstart?.();
  });
  stop = vi.fn(() => {
    this.onend?.();
  });
  abort = vi.fn();

  constructor() {
    lastRecognition = this;
  }
}

// ── Mock speechSynthesis ──────────────────────────────────────────────────────

const mockSynthSpeak = vi.fn();
const mockSynthCancel = vi.fn();

const mockSpeechSynthesis = {
  speak: mockSynthSpeak,
  cancel: mockSynthCancel,
  paused: false,
  pending: false,
  speaking: false,
  getVoices: vi.fn(() => []),
  pause: vi.fn(),
  resume: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
  onvoiceschanged: null,
};

// ── Mock SpeechSynthesisUtterance ─────────────────────────────────────────────

let lastUtterance: MockUtterance | null = null;

class MockUtterance {
  text: string;
  onend: (() => void) | null = null;
  lang = "";
  voice = null;
  volume = 1;
  rate = 1;
  pitch = 1;

  constructor(text: string) {
    this.text = text;
    lastUtterance = this;
  }
}

// ── Harness component ─────────────────────────────────────────────────────────
//
// Renders useVoice, captures state via a module-level variable, and notifies
// via an onCapture callback after every effect flush.

let capturedState: UseVoiceResult | null = null;

function VoiceHarness({ onCapture }: { onCapture?: () => void }) {
  const voice = useVoice();
  capturedState = voice;
  useEffect(() => {
    capturedState = voice;
    onCapture?.();
  });
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildFakeSpeechEvent(transcript: string): FakeRecognitionEvent {
  const alternative = { transcript, confidence: 1 } as SpeechRecognitionAlternative;
  const result = Object.assign([alternative], {
    isFinal: true,
    length: 1,
    item: (_i: number) => alternative,
  }) as unknown as SpeechRecognitionResult;
  const resultList = Object.assign([result], {
    length: 1,
    item: (_i: number) => result,
  }) as unknown as SpeechRecognitionResultList;
  return { resultIndex: 0, results: resultList };
}

// ── Suite setup / teardown ────────────────────────────────────────────────────

describe("stripMarkdownForSpeech", () => {
  it("removes bold markers", () => {
    expect(stripMarkdownForSpeech("Hello **world**!")).toBe("Hello world!");
  });

  it("removes image syntax entirely", () => {
    expect(stripMarkdownForSpeech("See ![snapshot](http://example.com/clip.mp4)")).toBe("See");
  });

  it("converts links to link text only", () => {
    expect(stripMarkdownForSpeech("[Watch clip](http://example.com/clip.mp4)")).toBe("Watch clip");
  });

  it("does not speak Watch clip URLs", () => {
    const text = "[Watch clip](http://host/api/clips/cam/ts/index.m3u8)";
    expect(stripMarkdownForSpeech(text)).toBe("Watch clip");
    expect(stripMarkdownForSpeech(text)).not.toContain("http");
  });

  it("removes ATX heading markers", () => {
    expect(stripMarkdownForSpeech("## Incident Summary")).toBe("Incident Summary");
  });

  it("removes table pipes", () => {
    expect(stripMarkdownForSpeech("| Camera | Time |")).not.toContain("|");
  });

  it("strips agent reasoning blocks", () => {
    const raw = "<agent-think>internal plan</agent-think>Answer here.";
    expect(stripMarkdownForSpeech(raw)).toBe("Answer here.");
  });

  it("strips agent reasoning step blocks", () => {
    const raw =
      '<agent-think-step title="Tool call">...</agent-think-step>Final answer.';
    expect(stripMarkdownForSpeech(raw)).toBe("Final answer.");
  });

  it("strips inline code backticks but keeps content", () => {
    expect(stripMarkdownForSpeech("Run `kubectl get pods`")).toBe("Run kubectl get pods");
  });

  it("returns empty string for markdown-only input", () => {
    expect(stripMarkdownForSpeech("![](http://x.com/a.mp4)")).toBe("");
  });
});

// ── useVoice hook tests ───────────────────────────────────────────────────────

describe("useVoice", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    lastRecognition = null;
    lastUtterance = null;
    capturedState = null;
    mockSynthSpeak.mockClear();
    mockSynthCancel.mockClear();

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    // Clean up window stubs
    delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
    delete (window as unknown as Record<string, unknown>).SpeechRecognition;
    delete (window as unknown as Record<string, unknown>).SpeechSynthesisUtterance;
    delete (window as unknown as Record<string, unknown>).speechSynthesis;
  });

  // ── 1. supported reflects presence of both APIs ───────────────────────────

  it("sets supported=true when both webkitSpeechRecognition and speechSynthesis are present", async () => {
    Object.defineProperty(window, "webkitSpeechRecognition", {
      value: MockRecognition,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, "speechSynthesis", {
      value: mockSpeechSynthesis,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      value: MockUtterance,
      configurable: true,
      writable: true,
    });

    await act(async () => {
      root.render(React.createElement(VoiceHarness, {}));
    });

    expect(capturedState?.supported).toBe(true);
  });

  it("sets supported=false when SpeechRecognition is absent", async () => {
    Object.defineProperty(window, "speechSynthesis", {
      value: mockSpeechSynthesis,
      configurable: true,
      writable: true,
    });
    // Do NOT install webkitSpeechRecognition or SpeechRecognition.

    await act(async () => {
      root.render(React.createElement(VoiceHarness, {}));
    });

    expect(capturedState?.supported).toBe(false);
  });

  it("sets supported=false when speechSynthesis is absent", async () => {
    Object.defineProperty(window, "webkitSpeechRecognition", {
      value: MockRecognition,
      configurable: true,
      writable: true,
    });
    // Do NOT install speechSynthesis.

    await act(async () => {
      root.render(React.createElement(VoiceHarness, {}));
    });

    expect(capturedState?.supported).toBe(false);
  });

  // ── 2. startListening → onresult → onFinal ───────────────────────────────

  it("calls onFinal with the final transcript from onresult", async () => {
    Object.defineProperty(window, "webkitSpeechRecognition", {
      value: MockRecognition,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, "speechSynthesis", {
      value: mockSpeechSynthesis,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      value: MockUtterance,
      configurable: true,
      writable: true,
    });

    await act(async () => {
      root.render(React.createElement(VoiceHarness, {}));
    });

    const onFinal = vi.fn();

    act(() => {
      capturedState?.startListening(onFinal);
    });

    expect(lastRecognition).not.toBeNull();
    expect(lastRecognition!.start).toHaveBeenCalled();

    // Fire the onresult event with a final transcript.
    act(() => {
      lastRecognition!.onresult?.(buildFakeSpeechEvent("show me recent incidents") );
    });

    expect(onFinal).toHaveBeenCalledOnce();
    expect(onFinal).toHaveBeenCalledWith("show me recent incidents");
  });

  it("sets lang to en-US on the recognition instance", async () => {
    Object.defineProperty(window, "webkitSpeechRecognition", {
      value: MockRecognition,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, "speechSynthesis", {
      value: mockSpeechSynthesis,
      configurable: true,
      writable: true,
    });

    await act(async () => {
      root.render(React.createElement(VoiceHarness, {}));
    });

    act(() => {
      capturedState?.startListening(vi.fn());
    });

    expect(lastRecognition?.lang).toBe("en-US");
    expect(lastRecognition?.interimResults).toBe(false);
    expect(lastRecognition?.continuous).toBe(false);
  });

  it("does not call onFinal for empty transcripts", async () => {
    Object.defineProperty(window, "webkitSpeechRecognition", {
      value: MockRecognition,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, "speechSynthesis", {
      value: mockSpeechSynthesis,
      configurable: true,
      writable: true,
    });

    await act(async () => {
      root.render(React.createElement(VoiceHarness, {}));
    });

    const onFinal = vi.fn();
    act(() => {
      capturedState?.startListening(onFinal);
    });

    act(() => {
      lastRecognition!.onresult?.(buildFakeSpeechEvent("   ") );
    });

    expect(onFinal).not.toHaveBeenCalled();
  });

  // ── 3. speak calls speechSynthesis.speak with stripped text ──────────────

  it("calls speechSynthesis.speak with markdown-stripped text", async () => {
    Object.defineProperty(window, "webkitSpeechRecognition", {
      value: MockRecognition,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, "speechSynthesis", {
      value: mockSpeechSynthesis,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      value: MockUtterance,
      configurable: true,
      writable: true,
    });

    await act(async () => {
      root.render(React.createElement(VoiceHarness, {}));
    });

    act(() => {
      capturedState?.speak("**Incident detected.** [Watch clip](http://host/clip.mp4)");
    });

    expect(mockSynthSpeak).toHaveBeenCalledOnce();
    const utteranceArg = mockSynthSpeak.mock.calls[0][0] as MockUtterance;
    expect(utteranceArg.text).not.toContain("**");
    expect(utteranceArg.text).not.toContain("](");
    expect(utteranceArg.text).not.toContain("[Watch clip");
    expect(utteranceArg.text).toContain("Incident detected");
    expect(utteranceArg.text).toContain("Watch clip");
  });

  it("does not call speechSynthesis.speak when text is empty after stripping", async () => {
    Object.defineProperty(window, "webkitSpeechRecognition", {
      value: MockRecognition,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, "speechSynthesis", {
      value: mockSpeechSynthesis,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      value: MockUtterance,
      configurable: true,
      writable: true,
    });

    await act(async () => {
      root.render(React.createElement(VoiceHarness, {}));
    });

    act(() => {
      // Only an image — strip produces empty string.
      capturedState?.speak("![](http://host/clip.mp4)");
    });

    expect(mockSynthSpeak).not.toHaveBeenCalled();
  });

  it("calls the onEnd callback after utterance ends", async () => {
    Object.defineProperty(window, "webkitSpeechRecognition", {
      value: MockRecognition,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, "speechSynthesis", {
      value: mockSpeechSynthesis,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      value: MockUtterance,
      configurable: true,
      writable: true,
    });

    await act(async () => {
      root.render(React.createElement(VoiceHarness, {}));
    });

    const onEnd = vi.fn();
    act(() => {
      capturedState?.speak("Hello there.", onEnd);
    });

    expect(lastUtterance?.onend).toBe(onEnd);
    // Simulate utterance end.
    act(() => {
      lastUtterance!.onend?.();
    });
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("cancelSpeak delegates to speechSynthesis.cancel", async () => {
    Object.defineProperty(window, "webkitSpeechRecognition", {
      value: MockRecognition,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, "speechSynthesis", {
      value: mockSpeechSynthesis,
      configurable: true,
      writable: true,
    });

    await act(async () => {
      root.render(React.createElement(VoiceHarness, {}));
    });

    act(() => {
      capturedState?.cancelSpeak();
    });

    expect(mockSynthCancel).toHaveBeenCalledOnce();
  });
});
