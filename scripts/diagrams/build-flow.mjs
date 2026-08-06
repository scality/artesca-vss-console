// ISV-ARCH-06 — one frame, end to end.
//
// The other sheets are structural: what exists and how it is wired. This one
// follows a single frame from the lens to the operator, and marks where it
// lands on ARTESCA and where an operator's decision changes what happens to it.
//
// Component names, Kafka topics and bucket names come from dump-flow.mjs, which
// imports the console's own cluster-refs.ts. Nothing here is transcribed.
//
//   node --conditions=react-server scripts/diagrams/dump-flow.mjs > flow.json
//   node scripts/diagrams/build-flow.mjs flow.json out.excalidraw

import { readFileSync, writeFileSync } from 'node:fs';

const LIB = '../../../isv-presentations/diagrams/lib/excalidraw-lib.mjs';
let createScene, PALETTE, findOverlaps;
try {
  ({ createScene, PALETTE, findOverlaps } = await import(LIB));
} catch {
  console.error(`Cannot load the shared scene builder at ${LIB}\nClone scality/isv-presentations next to this repository.`);
  process.exit(1);
}
const P = PALETTE;

const m = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const OUT = process.argv[3];
const S = createScene();

const W = 1900;
const centred = (t, fs) => W / 2 - t.length * fs * 0.26;
const stage = (id) => m.stages.find((s) => s.id === id);

function wrap(str, cols) {
  const out = [];
  let cur = '';
  for (const w of String(str).split(' ')) {
    if ((cur + ' ' + w).trim().length <= cols) cur = (cur + ' ' + w).trim();
    else { out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  return out.join('\n');
}

const title = 'One frame, end to end';
S.text('t_title', centred(title, 30), 15, title, 30);
const sub = `from the lens to the operator, in namespace ${m.namespace} — component names read from the console's cluster-refs`;
S.text('t_sub', centred(sub, 17), 55, sub, 17, P.muted);

// ── band 1: the path ─────────────────────────────────────────────────────────
S.rect('z_path', 40, 92, 1820, 322, { bg: P.zone.blue, stroke: P.blue, sw: 1, op: 28 });
S.text('t_path', 60, 102, 'One ingest, three paths — they run at the same time, not in sequence', 18, P.ink.blue);
S.text('t_pathc', 60, 126,
  'the recording path never waits on the GPU: a frame is durable on ARTESCA whether or not the model has anything to say about it', 14, P.muted);

const LX = [480, 712, 944, 1176, 1408, 1640];
const BW = 212, BH = 56;
const LANE = { record: 158, infer: 234, index: 310 };

// the shared head of the path
S.rect('n_cam', 60, LANE.infer, 178, BH, {
  bg: P.fill.amber, stroke: P.amber, fs: 13, label: 'RTSP camera\nrail or simulator',
});
S.rect('n_vst', 258, LANE.infer, 200, BH, {
  bg: P.fill.blue, stroke: P.blue, fs: 13, label: `VST ingest\n${stage('vst').detail.split('.')[0]}`,
});
S.arrow('a_cam', 240, LANE.infer + BH / 2, [[0, 0], [16, 0]], { stroke: P.amber });
// fan-out to the three lanes
S.arrow('a_fan_r', 460, LANE.infer + BH / 2, [[0, 0], [10, 0], [10, LANE.record - LANE.infer + BH / 2], [18, LANE.record - LANE.infer + BH / 2]], { stroke: P.blue, sw: 1 });
S.arrow('a_fan_i', 460, LANE.infer + BH / 2, [[0, 0], [18, 0]], { stroke: P.blue, sw: 1 });
S.arrow('a_fan_x', 460, LANE.infer + BH / 2, [[0, 0], [10, 0], [10, LANE.index - LANE.infer + BH / 2], [18, LANE.index - LANE.infer + BH / 2]], { stroke: P.blue, sw: 1 });

/** A lane of boxes with arrows between them. */
function lane(prefix, y, cells) {
  cells.forEach((c, i) => {
    S.rect(`${prefix}_${i}`, LX[i], y, BW, BH, { bg: c.bg, stroke: c.stroke, fs: 12, label: c.label });
    if (i > 0) S.arrow(`${prefix}a_${i}`, LX[i] - 20, y + BH / 2, [[0, 0], [18, 0]], { stroke: c.stroke, sw: 1 });
  });
}

lane('rec', LANE.record, [
  { bg: P.fill.blue, stroke: P.blue, label: `recorder\n${stage('recorder').detail}` },
  { bg: P.fill.green, stroke: P.green, label: `ARTESCA S3\n${m.buckets.recordings}` },
]);
lane('inf', LANE.infer, [
  { bg: P.fill.purple, stroke: P.purple, label: `vision model — GPU\n${stage('vlm').detail.split('.')[0]}` },
  { bg: P.fill.yellow, stroke: P.amber, label: `kafka topic\n${m.topics.visionLlm}` },
  { bg: P.fill.amber, stroke: P.amber, label: `alert worker\nkeyword rules` },
  { bg: P.fill.yellow, stroke: P.amber, label: `kafka topic\n${m.topics.incidents}` },
  { bg: P.fill.green, stroke: P.green, label: `ARTESCA S3\n${m.buckets.alertClips}` },
]);
lane('idx', LANE.index, [
  { bg: P.fill.purple, stroke: P.purple, label: 'embedding pass' },
  { bg: P.fill.yellow, stroke: P.amber, label: `kafka topic\n${m.topics.embedMessages}` },
  { bg: P.fill.cyan, stroke: P.cyan, label: `caption indexer\n${stage('indexer').detail.split('.')[0]}` },
  { bg: P.fill.green, stroke: P.green, label: `ARTESCA S3\n${m.buckets.agentCorpus}` },
]);

S.text('l_rec', 300, LANE.record + 16, 'record', 14, P.ink.blue);
S.text('l_inf', 300, LANE.infer - 26, 'infer', 14, P.ink.purple);
S.text('l_idx', 300, LANE.index + 16, 'index', 14, P.ink.cyan);

// ── band 2: where the operator enters ────────────────────────────────────────
S.rect('z_ctl', 40, 434, 1820, 176, { bg: P.zone.amber, stroke: P.amber, sw: 1, op: 26 });
S.text('t_ctl', 60, 444, 'Where an operator changes what happens to the frame', 18, P.ink.amber);
S.text('t_ctlc', 60, 468,
  'the console is not a viewer over this path — four of its pages are inputs to it', 14, P.muted);
m.controls.forEach((c, i) => {
  S.rect(`c_${i}`, 62 + i * 452, 500, 432, 92, {
    bg: '#ffffff', stroke: P.amber, sw: 1, fs: 13,
    label: `${c.what}\n\n${wrap(c.where, 46)}`,
  });
});

// ── band 3: what comes back ──────────────────────────────────────────────────
S.rect('z_read', 40, 630, 1820, 186, { bg: P.zone.cyan, stroke: P.cyan, sw: 1, op: 26 });
S.text('t_read', 60, 640, 'What the operator sees, and which carrier it came off', 18, P.ink.cyan);
S.text('t_readc', 60, 664,
  'every page on the left reads one of the carriers above — none of it is a second copy of the data', 14, P.muted);
m.reads.forEach((r, i) => {
  const col = i % 3, row = Math.floor(i / 3);
  S.rect(`r_${i}`, 62 + col * 606, 696 + row * 58, 586, 50, {
    bg: '#ffffff', stroke: P.cyan, sw: 1, fs: 13,
    label: `${r.page}   ←   ${r.via}`,
  });
});

// ── band 4: what the path says ───────────────────────────────────────────────
S.rect('z_find', 40, 836, 1820, 210, { bg: P.zone.green, stroke: P.green, sw: 1, op: 25 });
S.text('t_find', 60, 846, 'What the path says', 18, P.ink.green);

const nBuckets = Object.keys(m.buckets).length;
const findings = [
  ['Every path ends on ARTESCA',
   `All ${nBuckets} buckets — ${Object.values(m.buckets).join(', ')} — are on the in-store cluster. Recordings, the incident clips shown as evidence, and the corpus the assistant answers from. Nothing in this diagram leaves the store.`],
  ['The GPU is not in the durable path',
   'The recording lane forks off at ingest and reaches S3 without touching the model. A saturated or failed GPU costs captions, alerts and search — it does not cost the footage, which is the part with a legal retention obligation.'],
  ['An incident is a keyword decision',
   `The model captions everything it is shown; the alert worker decides what counts by matching scenario keywords over those captions and emits ${m.topics.incidents}. That rule is operator-editable, which is why the same pipeline serves a different vertical without a model change.`],
];
findings.forEach(([head, body], i) => {
  const x = 62 + i * 600;
  S.rect(`f_${i}`, x, 878, 576, 152, { bg: '#ffffff', stroke: P.green, sw: 1 });
  S.text(`fh_${i}`, x + 16, 890, head, 15, '#15803d');
  S.text(`fb_${i}`, x + 16, 916, wrap(body, 62), 13, '#3d4a56');
});

const overlaps = findOverlaps(S.els);
if (overlaps.length) {
  console.error('layout collision — boxes overlap:');
  for (const o of overlaps) console.error(`  ${o.a} / ${o.b}  (${Math.round(o.dx)}x${Math.round(o.dy)}px)`);
  process.exit(1);
}

writeFileSync(OUT, JSON.stringify(S.toFile(), null, 2));
console.log(`wrote ${OUT}`);
console.log(`${S.els.length} elements | ${m.stages.length} stages | ${Object.keys(m.topics).length} topics | ${nBuckets} buckets`);
