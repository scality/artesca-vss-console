// Emits the video path's real component names for the ISV-ARCH-06 flow sheet.
//
// Imports cluster-refs.ts, which the console's own CLAUDE.md calls the canonical
// lookup for every in-cluster service, ConfigMap, Deployment, env key and topic
// the console addresses. Importing it beats parsing: the values are computed
// from process.env with defaults, so a regex would read the source of a name
// rather than the name.
//
// ⚠ cluster-refs.ts starts with `import "server-only"`, whose default entry
// throws by design. The no-op is behind the react-server export condition, so
// this must run as:
//
//   node --conditions=react-server scripts/diagrams/dump-flow.mjs > flow.json
//
// ⚠ CLUSTER carries live credentials — CLUSTER.grafana.password among them.
// This dumper emits an explicit allowlist and never the object, because its
// output is rendered onto a sheet that gets published.

const REPO = new URL('../../', import.meta.url).pathname;
const { CLUSTER } = await import(`${REPO}src/lib/cluster-refs.ts`);

/** Host of a URL, or the raw value when it is not one — never query or auth. */
const host = (u) => {
  try { return new URL(u).host; } catch { return u || '(unset)'; }
};

const flow = {
  namespace: CLUSTER.vssNamespace,
  legacy: CLUSTER.legacy,

  // The carriers. Every stage boundary in the path is one of these.
  topics: CLUSTER.kafka.topics,
  buckets: CLUSTER.s3.buckets,

  // The components, in the order a frame meets them.
  stages: [
    { id: 'camera', label: 'RTSP camera', detail: 'Pyramid Camera Rail, or the camera simulator',
      kind: 'edge' },
    { id: 'vst', label: 'VST — video storage toolkit', detail: host(CLUSTER.vst.sensorUrl),
      kind: 'ingest', note: 'one ingest, fanned out three ways' },
    { id: 'recorder', label: 'VST recorder', detail: CLUSTER.vst.recorderConfig.configMap,
      kind: 'record' },
    { id: 'vlm', label: 'rtvi-vlm — the vision model', detail: host(CLUSTER.alertBridge.vlmModelsUrl),
      kind: 'gpu', note: 'captions every frame it is given' },
    { id: 'alerts', label: 'alert worker', detail: host(CLUSTER.alertWorker.url),
      kind: 'judge', note: 'keyword rules over captions decide what is an incident' },
    { id: 'indexer', label: 'caption indexer', detail: host(CLUSTER.search.url),
      kind: 'index', note: 'embeds captions for semantic search' },
    { id: 'agent', label: 'vss-agent', detail: host(CLUSTER.agent.url),
      kind: 'ask' },
    { id: 'console', label: 'console :8800', detail: 'the operator surface',
      kind: 'surface' },
  ],

  // Where the operator's decisions enter the path — the reason the console is
  // not merely a viewer.
  controls: [
    { at: 'vst', what: 'which cameras exist', where: 'cameras, reconciled from the config store' },
    { at: 'vlm', what: 'what the model is asked', where: 'VLM prompt + prompt sets' },
    { at: 'alerts', what: 'what counts as an incident', where: 'scenarios — keywords, severity, cooldown' },
    { at: 'vlm', what: 'how hard the GPU works', where: 'tuning — sampling, batch, KV cache' },
  ],

  // What the console reads back, and from which carrier.
  reads: [
    { page: '/incidents', from: 'kafka', via: CLUSTER.kafka.topics.incidents },
    { page: '/cameras', from: 'vst', via: host(CLUSTER.vst.sensorUrl) },
    { page: '/search', from: 'indexer', via: host(CLUSTER.search.url) },
    { page: '/chat', from: 'agent', via: host(CLUSTER.agent.url) },
    { page: '/storage', from: 's3', via: 'all three buckets' },
    { page: '/evidence', from: 's3', via: CLUSTER.s3.buckets.alertClips },
  ],

  s3Endpoint: CLUSTER.s3.endpoint || '(set at deploy time)',
  restartable: Object.keys(CLUSTER.restartable),
};

console.log(JSON.stringify(flow, null, 2));
