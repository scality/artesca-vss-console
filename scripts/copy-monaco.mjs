#!/usr/bin/env node
/**
 * Copy Monaco's AMD build into `public/monaco/vs` so the app serves the editor
 * itself instead of fetching it from cdn.jsdelivr.net at runtime (ISVD-586).
 *
 * `@monaco-editor/react` resolves Monaco from its public CDN unless
 * `loader.config()` names another source. `src/components/monaco.ts` points it
 * at `/monaco/vs`, which is this copy — so the two have to stay together: the
 * path there is the destination here.
 *
 * Run from three hooks, because there are three ways the app gets served and
 * each needs the assets on disk:
 *
 *   prebuild      `next build` — the image, and CI
 *   predev        `npm run dev`
 *   pretest:e2e   Playwright, which spawns `npx next dev` directly rather than
 *                 through `npm run dev`, so `predev` never fires for it
 *
 * A `postinstall` hook would cover all three at once and is deliberately not
 * used: the Dockerfile installs with `npm ci --ignore-scripts`, so it would be
 * skipped exactly where it matters most.
 *
 * The whole of `min/vs` is copied (~13 MB), not the two languages currently in
 * use. Monaco fetches language contributions and workers lazily by path, so a
 * trimmed copy turns a later `language="yaml"` into a 404 that only appears on
 * a cluster with no egress — the failure this script exists to remove. The
 * image already ships ffmpeg; 13 MB of static assets is not the constraint.
 */
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const pkgPath = require.resolve("monaco-editor/package.json");
const version = JSON.parse(await readFile(pkgPath, "utf8")).version;
const src = path.join(path.dirname(pkgPath), "min", "vs");

const outDir = path.join(ROOT, "public", "monaco");
const dest = path.join(outDir, "vs");
// Records which version the copy is of, so a dependency bump replaces it
// instead of leaving a mix of two Monaco versions behind.
const stampFile = path.join(outDir, ".version");

if (!existsSync(src)) {
  console.error(
    `copy-monaco: ${src} does not exist.\n` +
      "monaco-editor ships its AMD build there; without it the editor would " +
      "fall back to the public CDN. Run `npm ci` and try again."
  );
  process.exit(1);
}

const stamped = existsSync(stampFile)
  ? (await readFile(stampFile, "utf8")).trim()
  : null;

if (stamped === version && existsSync(dest)) {
  console.log(`copy-monaco: public/monaco/vs already at ${version}`);
  process.exit(0);
}

// Replace rather than merge — a version bump renames files, and copying over
// the top would leave the previous version's chunks behind to be lazily loaded.
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await cp(src, dest, { recursive: true });
await writeFile(stampFile, `${version}\n`);

console.log(
  `copy-monaco: ${stamped ? `${stamped} -> ${version}` : version} into public/monaco/vs`
);
