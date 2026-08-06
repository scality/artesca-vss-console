"use client";

/**
 * The only place Monaco enters this app.
 *
 * `@monaco-editor/react` loads Monaco from cdn.jsdelivr.net unless
 * `loader.config()` names another source, and it resolves whatever version the
 * CDN currently serves rather than the one in package-lock. Neither is
 * acceptable here: the Pyramid showroom runs on a node whose egress is not
 * guaranteed, and editing the VLM prompt is a core demo action — so the editor
 * has to come out of the image (ISVD-586).
 *
 * `/monaco/vs` is the copy `scripts/copy-monaco.mjs` puts in `public/`. Monaco's
 * own AMD loader resolves its language contributions and web workers relative
 * to that path, and it is same-origin, so no `MonacoEnvironment` worker wiring
 * is needed.
 *
 * Import the editors from here, never from `@monaco-editor/react` directly — a
 * direct import gets the CDN back. `tests/unit/monaco-single-entry.test.ts`
 * fails if one appears.
 */
import { loader } from "@monaco-editor/react";

/** Path under `public/` that `scripts/copy-monaco.mjs` writes. */
export const MONACO_VS_PATH = "/monaco/vs";

/**
 * The same path, origin-qualified — and it has to be.
 *
 * Monaco runs each language service in a web worker created from a **blob**
 * URL, and a blob URL is an opaque origin with no base for a relative path to
 * resolve against. Given `/monaco/vs`, the worker's own loader fails with
 * `Failed to parse URL from /monaco/vs/language/json/jsonWorker.js` and the
 * service never starts.
 *
 * The failure is quiet in the way that matters: the editor still renders and
 * still accepts typing, so `/prompt` looks perfectly healthy. What disappears
 * is JSON validation, formatting and hover on the two `language="json"`
 * editors — the scenario diff and the incident raw payload.
 */
function vsUrl(): string {
  // Only reached in the browser (every consumer imports this through
  // `dynamic(..., { ssr: false })`); the bare path keeps a direct import from
  // throwing during a server render.
  return typeof window === "undefined"
    ? MONACO_VS_PATH
    : `${window.location.origin}${MONACO_VS_PATH}`;
}

// Runs on module evaluation, which precedes any consumer touching the exports
// below. The editors call `loader.init()` from an effect on mount, so the
// configuration is always in place before the first fetch.
loader.config({ paths: { vs: vsUrl() } });

export { default as MonacoEditor, DiffEditor } from "@monaco-editor/react";
