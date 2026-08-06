// ISV-ARCH-05 — the VSS console: the operator surface, the state it shares with
// the deployer, and what a click actually reaches.
//
// Renders the JSON dump-model.mjs emits from the console's own source, so the
// sheet cannot show a page that is not in the nav, miss an API route that
// exists, or disagree with the kiosk lists the middleware enforces.
//
//   node scripts/diagrams/dump-model.mjs > model.json
//   node scripts/diagrams/build-console.mjs model.json out.excalidraw

import { readFileSync, writeFileSync } from 'node:fs';

const LIB = '../../../../isv-presentations/diagrams/lib/excalidraw-lib.mjs';
let createScene, PALETTE, findOverlaps;
try {
  ({ createScene, PALETTE, findOverlaps } = await import(LIB));
} catch {
  console.error(`Cannot load the shared scene builder at ${LIB}\nClone scality/isv-presentations next to isv-labs.`);
  process.exit(1);
}
const P = PALETTE;

const m = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const OUT = process.argv[3];
const S = createScene();

const W = 1900;
const centred = (t, fs) => W / 2 - t.length * fs * 0.26;

/** Greedy wrap to a character budget — no silent truncation. */
function wrapToWidth(str, cols) {
  const lines = [];
  let cur = '';
  for (const w of String(str).split(' ')) {
    if ((cur + ' ' + w).trim().length <= cols) cur = (cur + ' ' + w).trim();
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.join('\n');
}

const hidden = new Set(m.kiosk.hidden);
const orphaned = new Set(m.orphaned);

const title = 'ARTESCA+ VSS console — the operator surface';
S.text('t_title', centred(title, 30), 15, title, 30);
const sub = `${m.pageCount} pages on :8800 in the cluster · ${m.api.length} API routes · ${m.mutatingCount} of them mutating`;
S.text('t_sub', centred(sub, 18), 55, sub, 18, P.muted);

// ── band 1: the pages, by what kiosk mode does to each ────────────────────────
S.rect('z_nav', 40, 92, 1820, 344, { bg: P.zone.blue, stroke: P.blue, sw: 1, op: 30 });
S.text('t_nav', 60, 102, 'The four sidebar sections, and what a showroom visitor sees', 18, P.ink.blue);
S.text('t_navc', 60, 126,
  'kiosk mode is a display mode layered on an authenticated session — the sidebar hides some pages, the middleware refuses others', 14, P.muted);

// green = reachable in kiosk · grey = hidden from the sidebar · red = shown but redirected
const pageStyle = (href) =>
  orphaned.has(href) ? [P.fill.red, P.red]
    : hidden.has(href) ? ['#f1f3f5', P.muted]
      : [P.fill.green, P.green];

const GX = 60, GW = 440, GGAP = 12;
m.nav.forEach((g, gi) => {
  const x = GX + gi * (GW + GGAP);
  S.text(`gh_${gi}`, x + 4, 158, `${g.label}  (${g.routes.length})`, 15, P.ink.blue);
  g.routes.forEach((r, ri) => {
    const [bg, stroke] = pageStyle(r.href);
    S.rect(`p_${gi}_${ri}`, x, 182 + ri * 34, GW, 28, {
      bg, stroke, fs: 13, label: `${r.label}    ${r.href}`,
    });
  });
});

const legend = [
  [P.fill.green, P.green, `reachable in kiosk — ${m.kiosk.allowed.length}`],
  ['#f1f3f5', P.muted, `hidden from the sidebar — ${m.kiosk.hidden.length}`],
  [P.fill.red, P.red, `still linked, then redirected — ${m.orphaned.length}`],
];
legend.forEach(([bg, stroke, label], i) => {
  S.rect(`lg_${i}`, 60 + i * 470, 392, 450, 28, { bg, stroke, fs: 13, label });
});

// ── band 2: the state shared with the deployer ────────────────────────────────
S.rect('z_state', 40, 456, 900, 300, { bg: P.zone.purple, stroke: P.purple, sw: 1, op: 28 });
S.text('t_state', 60, 466, 'State shared with the deployer', 18, P.ink.purple);
S.text('t_statec', 60, 490,
  'the deployer provisions the cluster, then both write the same Firestore documents', 14, P.muted);

S.rect('st_dep', 62, 522, 250, 60, {
  bg: P.fill.amber, stroke: P.amber, fs: 14, label: 'deployer :5002\nlaptop-side, pre-install',
});
S.rect('st_con', 668, 522, 250, 60, {
  bg: P.fill.blue, stroke: P.blue, fs: 14, label: 'console :8800\nin-cluster, post-install',
});
S.rect('st_fs', 344, 514, 292, 76, {
  bg: P.fill.purple, stroke: P.purple, fs: 14,
  label: `Firestore\n${m.configStore.methods.length} methods — ${m.configStore.reads} read, ${m.configStore.writes} write`,
});
S.arrow('a_dep', 316, 552, [[0, 0], [24, 0]], { stroke: P.amber });
S.arrow('a_con', 640, 552, [[24, 0], [0, 0]], { stroke: P.blue });

m.configStore.paths.forEach((p, i) => {
  S.rect(`fs_${i}`, 62 + (i % 2) * 428, 610 + Math.floor(i / 2) * 38, 418, 32, {
    bg: '#ffffff', stroke: P.purple, sw: 1, fs: 13, label: p,
  });
});
S.text('t_reconcile', 62, 692, wrapToWidth(
  'The reconciler converges the cluster onto these documents and writes back a status doc: what it applied, what drifted, what failed.', 96),
  13, '#3d4a56');

// ── band 3: what a click reaches ──────────────────────────────────────────────
S.rect('z_reach', 960, 456, 900, 300, { bg: P.zone.green, stroke: P.green, sw: 1, op: 25 });
S.text('t_reach', 980, 466, 'What the API routes reach', 18, P.ink.green);
S.text('t_reachc', 980, 490,
  'resolved through each route\'s imports, following dynamic ones too', 14, P.muted);

const reach = Object.entries(m.backendCounts)
  .filter(([, n]) => n > 0)
  .sort((a, b) => b[1] - a[1]);
reach.forEach(([key, n], i) => {
  const col = i % 2, row = Math.floor(i / 2);
  const share = Math.round((n / m.api.length) * 100);
  S.rect(`bk_${key.replace(/\W/g, '')}`, 982 + col * 438, 522 + row * 54, 428, 46, {
    bg: n >= 15 ? P.fill.green : P.fill.teal, stroke: P.green, fs: 14,
    label: `${m.backendLabels[key]} — ${n} routes  (${share}%)`,
  });
});
S.text('t_reachn', 982, 708, wrapToWidth(
  `${m.guardedCount} of the ${m.mutatingCount} mutating routes call rejectIfKiosk(); the rest are read paths for kiosk-visible pages, or the exit from kiosk mode itself.`, 92),
  13, '#3d4a56');

// ── band 4: what the source says ──────────────────────────────────────────────
S.rect('z_find', 40, 776, 1820, 216, { bg: P.zone.amber, stroke: P.amber, sw: 1, op: 25 });
S.text('t_find', 60, 786, 'What the source says', 18, P.ink.amber);

const findings = [
  [`${m.orphaned.length} nav links break in kiosk mode`,
   `${m.orphaned.join(', ')} are in neither kiosk list. The sidebar keeps showing them because it filters only the hidden list, and the middleware sends them to the overview because it serves only the allowed one. A showroom visitor clicks and lands back home.`],
  [`${m.unguardedOnHiddenPage.length} write routes outlive their own page`,
   `proxy.ts states that mutating API routes are guarded by rejectIfKiosk(). These sit under a page kiosk hides and accept a mutating verb without it — sharpest is /api/cameras/[id] DELETE, whose sibling collection route does guard.`],
  ['Two stores, one config',
   `API routes read and write GCS config on ${m.backendCounts['helpers/gcs-config']} routes; the reconcile path uses Firestore on ${m.backendCounts['config-store/firestore']}. Both describe the same cameras, prompt and scenarios.`],
];
findings.forEach(([head, body], i) => {
  const x = 62 + i * 600;
  S.rect(`f_${i}`, x, 818, 576, 158, { bg: '#ffffff', stroke: P.amber, sw: 1 });
  S.text(`fh_${i}`, x + 16, 830, head, 15, '#b45309');
  S.text(`fb_${i}`, x + 16, 856, wrapToWidth(body, 62), 13, '#3d4a56');
});

const overlaps = findOverlaps(S.els);
if (overlaps.length) {
  console.error('layout collision — boxes overlap:');
  for (const o of overlaps) console.error(`  ${o.a} / ${o.b}  (${Math.round(o.dx)}x${Math.round(o.dy)}px)`);
  process.exit(1);
}

writeFileSync(OUT, JSON.stringify(S.toFile(), null, 2));
console.log(`wrote ${OUT}`);
console.log(`${S.els.length} elements | ${m.pageCount} pages | ${m.api.length} routes | ${reach.length} backends reached`);
