// Emits the console's own structure as JSON, for the ISV-ARCH-05 sheet.
//
// Everything here is read out of the console's source at run time, so the sheet
// cannot name a page that is not in the nav or miss an API route that exists.
// Three readings, in descending order of how hard they are to fool:
//
//   1. The API surface is walked from the route tree on disk, and each route's
//      backend reach is resolved TRANSITIVELY through its @/lib imports — a
//      route that reaches Kubernetes through two helpers still counts.
//   2. The kiosk lists and the ConfigStore contract are parsed from their
//      modules. Importing them would be stronger, but kiosk.ts type-imports a
//      Next internal that does not resolve outside a Next build.
//   3. NAV_GROUPS is parsed from Nav.tsx, which is a client component.
//
//   node scripts/diagrams/dump-model.mjs > model.json

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = join(ROOT, 'src');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// ── the nav, parsed from the client component that renders it ────────────────
function parseNav() {
  const src = read('src/components/Nav.tsx');
  const body = src.slice(src.indexOf('const NAV_GROUPS'), src.indexOf('export function Nav'));
  const groups = [];
  for (const chunk of body.split(/\n\s*\{\s*\n\s*label:/).slice(1)) {
    const label = chunk.match(/^\s*"([^"]+)"/)?.[1];
    if (!label) continue;
    const routes = [...chunk.matchAll(/\{\s*href:\s*"([^"]+)",\s*label:\s*"([^"]+)"/g)]
      .map(([, href, name]) => ({ href, label: name }));
    if (routes.length) groups.push({ label, routes });
  }
  return groups;
}

// ── the two kiosk lists ──────────────────────────────────────────────────────
function parseKiosk() {
  const src = read('src/lib/kiosk.ts');
  const list = (name) => {
    const start = src.indexOf(name);
    const slice = src.slice(start, src.indexOf('];', start));
    return [...slice.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  };
  return { hidden: list('KIOSK_HIDDEN_ROUTES'), allowed: list('KIOSK_ALLOWED_ROUTES') };
}

// ── the config-store contract shared with the deployer ───────────────────────
function parseConfigStore() {
  const types = read('src/lib/config-store/types.ts');
  const iface = types.slice(types.indexOf('export interface ConfigStore'));
  const methods = [...iface.matchAll(/^\s{2}(\w+)\(/gm)].map((m) => m[1]);

  // Two backends implement the contract. Read the list and the default from the
  // factory rather than writing them here, so the sheet cannot claim a backend
  // that was removed or miss one that was added.
  const index = read('src/lib/config-store/index.ts');
  const kindDecl = index.match(/^export type StoreKind = (.+);$/m);
  const kinds = kindDecl ? [...kindDecl[1].matchAll(/"(\w+)"/g)].map((k) => k[1]) : [];
  const defaultKind = /\?\s*"firestore"\s*:\s*"file"/.test(index) ? 'file' : 'unknown';

  // Where each backend puts an instance's data. The file layout is one document,
  // so its "paths" are the keys inside it; Firestore's are document paths.
  const fs = read('src/lib/config-store/firestore.ts');
  const firestorePaths = [...fs.matchAll(/=>\s*`(instances\/\$\{instance\}[^`]*)`/g)]
    .map((m) => m[1].replace('${instance}', '<instance>'));
  const file = read('src/lib/config-store/file.ts');
  const fileEntities = [...file.matchAll(/^\s{2}(cameras|scenarios|promptSets): Record/gm)].map((m) => m[1]);

  return {
    methods,
    reads: methods.filter((m) => m.startsWith('read')).length,
    writes: methods.length - methods.filter((m) => m.startsWith('read')).length,
    kinds,
    defaultKind,
    paths: [...new Set(firestorePaths)],
    fileEntities,
  };
}

// ── the API surface, walked from disk ────────────────────────────────────────
const BACKENDS = {
  k8s: 'Kubernetes', ssh: 'SSH to nodes', s3: 'S3 / ARTESCA',
  kafka: 'Kafka', redis: 'Redis', aws: 'AWS API',
  'config-store': 'Config store', 'helpers/gcs-config': 'GCS config',
};

/**
 * Every `@/lib/...` module a file imports — static AND dynamic.
 *
 * ⚠ The dynamic form is not an edge case here: the reconcile context is reached
 * through `await import("@/lib/reconcile/context")` in all 16 of its call sites,
 * so a static-only walk reports that no route touches the config store at all.
 */
function libImports(file) {
  const src = readFileSync(file, 'utf8');
  return [
    ...src.matchAll(/from\s+"@\/lib\/([\w./-]+)"/g),
    ...src.matchAll(/import\(\s*"@\/lib\/([\w./-]+)"\s*\)/g),
  ].map((m) => m[1]);
}

function resolveLib(mod) {
  for (const c of [`${mod}.ts`, `${mod}/index.ts`, `${mod}.tsx`]) {
    const p = join(SRC, 'lib', c);
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

/** Backends a lib module reaches, following @/lib imports transitively. */
const reachCache = new Map();
function libReach(mod, seen = new Set()) {
  if (reachCache.has(mod)) return reachCache.get(mod);
  if (seen.has(mod)) return new Set();
  seen.add(mod);
  const out = new Set();
  if (BACKENDS[mod]) out.add(mod);
  else if (mod.startsWith('config-store/')) out.add('config-store');
  const file = resolveLib(mod);
  if (file) for (const next of libImports(file)) for (const b of libReach(next, seen)) out.add(b);
  if (seen.size === 1) reachCache.set(mod, out);
  return out;
}

function walkRoutes(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkRoutes(p, acc);
    else if (e.name === 'route.ts') acc.push(p);
  }
  return acc;
}

const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'];
function parseApi() {
  return walkRoutes(join(SRC, 'app/api')).sort().map((file) => {
    const src = readFileSync(file, 'utf8');
    const methods = new Set(
      [...src.matchAll(/export\s+(?:async\s+function|function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)]
        .map((m) => m[1])
    );
    // NextAuth exports its handlers destructured: `export const { GET, POST } = handlers`
    for (const m of src.matchAll(/export\s+const\s+\{([^}]+)\}\s*=/g))
      for (const name of m[1].split(',').map((s) => s.trim()))
        if (MUTATING.includes(name) || name === 'GET') methods.add(name);

    const backends = new Set();
    for (const mod of libImports(file)) for (const b of libReach(mod)) backends.add(b);

    const route = '/api/' + file.slice(join(SRC, 'app/api').length + 1).replace(/\/route\.ts$/, '');
    return {
      route,
      page: '/' + (route.split('/')[2] ?? ''),
      methods: [...methods].sort(),
      mutating: [...methods].some((m) => MUTATING.includes(m)),
      kioskGuard: src.includes('rejectIfKiosk('),
      backends: [...backends].sort(),
    };
  });
}

const nav = parseNav();
const kiosk = parseKiosk();
const api = parseApi();

// A page in the nav that kiosk mode neither hides from the sidebar nor lets the
// middleware serve: the link renders and then bounces to "/".
const navHrefs = nav.flatMap((g) => g.routes.map((r) => r.href));
const orphaned = navHrefs.filter((h) => !kiosk.hidden.includes(h) && !kiosk.allowed.includes(h));

/**
 * Mutating routes that must NOT carry the guard, with the reason. Without this
 * the audit below reports its own escape hatch as a hole: /api/settings/kiosk
 * is how an operator leaves kiosk mode, so rejecting it in kiosk mode would
 * trap the session in the display it is trying to exit.
 */
const GUARD_EXEMPT = {
  '/api/settings/kiosk': 'the exit from kiosk mode — guarding it would trap the session',
};

// A mutating route whose own page kiosk hides, but which accepts the write
// anyway — the invariant proxy.ts states in its comment.
const unguardedOnHiddenPage = api.filter(
  (r) => r.mutating && !r.kioskGuard && kiosk.hidden.includes(r.page) && !GUARD_EXEMPT[r.route]
);

console.log(JSON.stringify({
  nav, kiosk, configStore: parseConfigStore(), api,
  pageCount: navHrefs.length,
  orphaned,
  unguardedOnHiddenPage: unguardedOnHiddenPage.map((r) => ({ route: r.route, methods: r.methods })),
  guardExempt: GUARD_EXEMPT,
  mutatingCount: api.filter((r) => r.mutating).length,
  guardedCount: api.filter((r) => r.mutating && r.kioskGuard).length,
  backendCounts: Object.fromEntries(
    Object.keys(BACKENDS).map((b) => [b, api.filter((r) => r.backends.includes(b)).length])
  ),
  backendLabels: BACKENDS,
}, null, 2));
