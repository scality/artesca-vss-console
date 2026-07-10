"use client";

import { useState } from "react";
import { Play } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Only http(s) or same-origin relative URLs are safe to render into a
 * src/href. Rendered markdown here is LLM/VLM-originated (chat replies,
 * generated incident reports — both attacker-influenceable via camera
 * feeds), so a javascript:/data: URL here would be XSS on click.
 */
const SAFE_URL_PATTERN = /^(https?:\/\/|\/)/i;
export function isSafeUrl(url: string | undefined): url is string {
  return typeof url === "string" && SAFE_URL_PATTERN.test(url.trim());
}

/** Anchors pointing at a clip file render as an inline <video> instead of a link. */
export const VIDEO_URL_PATTERN = /\.(mp4|webm|mov)(\?|$)/i;

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
export function mediaThumbUrl(clipUrl: string): string {
  return `/api/media-thumb?src=${encodeURIComponent(clipUrl)}`;
}

/**
 * Picture-first clip renderer: shows the recorded-frame still by default
 * (via /api/media-thumb) with a play affordance overlaid, and only mounts a
 * <video> — loading/playing the actual clip — once the operator clicks.
 * Without this, every clip link renders as a <video controls poster=…> up
 * front, which operators read as "a video clip" rather than "a picture".
 */
export function ClipStill({ clipUrl, alt }: { clipUrl: string; alt?: string }) {
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
 * Custom react-markdown renderers, shared by the chat page and the incident
 * "Generate Report" view: markdown from either source (the agent's reply,
 * or a generated incident report) is real markdown (**bold**, lists,
 * headings, tables — plus ![alt](url) for snapshots and [text](url) for
 * clips). With media URLs rewritten server-side to a same-origin proxy, the
 * img/a overrides below turn those links into a clickable image/still or a
 * real <img> — the content "just works" on click. Every element carries
 * theme-matched Tailwind classes since no typography plugin is installed.
 */
export const markdownComponents: Components = {
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

/**
 * Reusable markdown renderer wired to the shared `markdownComponents` — the
 * single place both the chat page and the incident "Generate Report" view
 * render markdown, so clip links / snapshots / tables render identically in
 * both. Renders bare (no wrapping element) unless `className` is given, so it
 * drops into an existing styled container without adding an extra node.
 */
export function MarkdownReport({
  markdown,
  className,
}: {
  markdown: string;
  className?: string;
}) {
  const content = (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {markdown}
    </ReactMarkdown>
  );
  return className ? <div className={className}>{content}</div> : content;
}
