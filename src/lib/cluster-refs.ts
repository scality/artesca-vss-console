/**
 * cluster-refs.ts — single source of truth for all in-cluster service names,
 * ConfigMap names, Deployment names, env-var keys, and topic names used by
 * the console API routes.
 *
 * Every value that can vary between environments reads from process.env first,
 * so operators can override via k8s/console/11-configmap-env.yaml at deploy
 * time without touching the image.
 *
 * Architecture note: all RTVI, VST, alerts, and demo-data pods run
 * hostNetwork:true on a single MetalK8s node.  Service DNS names work for
 * the console (which does NOT use hostNetwork), but the pods themselves
 * address each other via the bare node IP (10.42.1.111).  The console always
 * uses ClusterIP / headless-service DNS — the values below reflect that.
 */

// ─── Kafka / Redpanda ─────────────────────────────────────────────────────────
// Redpanda is deployed as StatefulSet "redpanda" in namespace "rtvi", not in
// a dedicated "artesca-kafka" namespace.  Headless service: redpanda.rtvi.
// The console is NOT hostNetwork, so it uses the ClusterIP / headless DNS name.
const KAFKA_BROKERS =
  process.env.KAFKA_BROKERS ?? "redpanda.rtvi.svc.cluster.local:9092";

// Topics created by k8s/rtvi/20-redpanda.yaml redpanda-topic-init Job.
const KAFKA_TOPICS = {
  visionLlm: "vision-llm-messages",
  incidents: "vision-llm-events-incidents",
  visionLlmErrors: "vision-llm-errors",
  embedMessages: "vision-embed-messages",
  embedErrors: "vision-embed-errors",
  // demo-data producer also writes to vision-llm-messages
  demoData: "vision-llm-messages",
} as const;

// ─── Redis ────────────────────────────────────────────────────────────────────
// Redis is in namespace "vst", service name "redis" (k8s/vst/21-redis.yaml).
// The console's original default "alerts-redis.alerts.svc.cluster.local:6379"
// was wrong — there is no Redis in the alerts namespace.
const REDIS_URL =
  process.env.REDIS_URL ?? "redis://redis.vst.svc.cluster.local:6379";

// ─── VST (sensor-ms) ─────────────────────────────────────────────────────────
// sensor-ms (k8s/vst/30-sensor-ms.yaml) binds :30000 (HTTP).
// Headless Service defined in k8s/vst/35-sensor-ms-service.yaml.
// VST API sensor list endpoint: GET /api/v1/live/sensor/list
const VST_SENSOR_URL =
  process.env.VST_SENSOR_URL ??
  "http://sensor-ms.vst.svc.cluster.local:30000/api/v1/live/sensor";

// ─── mediamtx ────────────────────────────────────────────────────────────────
// mediamtx runs in the "replay-server" Deployment in namespace
// "pyramid-ingress" (k8s/pyramid-ingress/21-replay-server.yaml).
// It exposes the REST API on :9997.  The console uses CAMERA_SIM_HOST as
// the mediamtx host because mediamtx is on the camera-sim EC2 instance (same
// host as the replay server), not inside the K8s cluster.
// MEDIAMTX_API_URL can override the full base URL.
const MEDIAMTX_API_URL =
  process.env.MEDIAMTX_API_URL ??
  `http://${process.env.CAMERA_SIM_HOST ?? "camera-sim-host"}:9997`;

// ─── Prometheus ───────────────────────────────────────────────────────────────
// ARTESCA ships kube-prometheus-stack in "artesca-monitoring".  The StatefulSet
// is "prometheus-prometheus-ltm" but the headless Service (auto-created by the
// prometheus-operator) is "prometheus-operated" — confirmed on the live cluster
// (endpoint 10.233.138.187:9090).  Headless DNS resolves directly to the pod IP,
// which is correct for in-cluster HTTP access.
const PROMETHEUS_URL =
  process.env.PROMETHEUS_URL ??
  "http://prometheus-operated.artesca-monitoring.svc.cluster.local:9090";

// ─── alert-worker ────────────────────────────────────────────────────────────
// alert-worker (k8s/alerts/20-alert-worker.yaml) exposes :9100 (hostPort).
// The headless Service is defined in k8s/alerts/21-alert-worker-service.yaml.
// DNS resolves alert-worker.alerts.svc.cluster.local to the pod/node IP
// (headless, consistent with redpanda and redis).
const ALERT_WORKER_URL =
  process.env.ALERT_WORKER_URL ??
  "http://alert-worker.alerts.svc.cluster.local:9100";

// ─── RTVI ────────────────────────────────────────────────────────────────────
// ConfigMap "rtvi-runtime-env" in namespace "rtvi" (k8s/rtvi/11-configmap-runtime-env.yaml).
// Key for system prompt: "RTVI_VLM_SYSTEM_PROMPT".
// Key for model deployment name: "RTVI_VLM_OPENAI_MODEL_DEPLOYMENT_NAME".
const RTVI = {
  runtimeEnvCm: "rtvi-runtime-env",
  promptKey: "RTVI_VLM_SYSTEM_PROMPT",
  /** Model key stored in the same ConfigMap (used by prompt API for model swap). */
  modelKey: "RTVI_VLM_OPENAI_MODEL_DEPLOYMENT_NAME",
  /** Deployment restarted after prompt/tuning changes. */
  vlmDeployment: "rtvi-vlm",
  /** rtvi-embed Deployment name. */
  embedDeployment: "rtvi-embed",
  /**
   * NIM StatefulSet — cosmos-reason2-8b (k8s/rtvi/30-nim-cosmos-reason2-8b.yaml).
   * It is a StatefulSet, not a Deployment.  The restart API route accounts for this.
   */
  nimStatefulSet: "cosmos-reason2-8b",
  nimNamespace: "rtvi",
  /**
   * KV-cache tuning key in rtvi-runtime-env.
   * The NIM reads env var NIM_KVCACHE_PERCENT, but the ConfigMap key is
   * VLM_NIM_KVCACHE_PERCENT (k8s/rtvi/30-nim-cosmos-reason2-8b.yaml line 52-54).
   */
  nimKvCacheKey: "VLM_NIM_KVCACHE_PERCENT",
  nimMaxModelLenKey: "NIM_MAX_MODEL_LEN",
  nimMaxNumSeqsKey: "NIM_MAX_NUM_SEQS",
} as const;

// ─── NIM preview endpoint ─────────────────────────────────────────────────────
// The k8s/console/11-configmap-env.yaml says "nvila-lite-preview" but
// .env.example says "nim-preview".  The ConfigMap is the authoritative
// deploy-time value; .env.example is for local dev only.
// Flag: ASSUMED — no NIM preview Deployment found in k8s/rtvi/; confirm name at deploy.
const NIM_PREVIEW_ENDPOINT =
  process.env.NIM_PREVIEW_ENDPOINT ??
  "http://nvila-lite-preview.rtvi.svc.cluster.local:8000";

// ─── Scenarios ────────────────────────────────────────────────────────────────
// ConfigMap name in k8s/alerts/12-configmap-scenarios.yaml is "scenarios",
// NOT "scenarios-config" as the console originally assumed.
const SCENARIOS = {
  namespace: "alerts",
  configMap: "scenarios",
  yamlKey: "scenarios.yaml",
  alertWorkerDeployment: "alert-worker",
} as const;

// ─── Alerts tuning ────────────────────────────────────────────────────────────
// The tuning/alerts route patches env keys in a ConfigMap.  The real ConfigMap
// is "alerts-runtime-env" (k8s/alerts/11-configmap-runtime-env.yaml), NOT
// "alert-worker-config" as the console originally assumed.
// The cooldown key is "COOLDOWN_SECONDS" — matches the console.
const ALERTS_TUNING = {
  namespace: "alerts",
  configMap: "alerts-runtime-env",
  cooldownKey: "COOLDOWN_SECONDS",
  slackConfiguredKey: "SLACK_WEBHOOK_CONFIGURED",
} as const;

// ─── Cameras / pyramid-ingress ────────────────────────────────────────────────
// ConfigMap name in k8s/pyramid-ingress/11-configmap-cameras.yaml is "cameras",
// NOT "cameras-config" as the console originally assumed.
//
// Schema difference: the real cameras.yaml uses "name" and "source" per entry,
// not "id", "role", and "feeds[].id".  The console's API routes were written
// assuming the wrong schema.  The CLUSTER object exposes the CM name; schema
// handling is fixed in cameras/route.ts.
//
// The register-cameras Job template (k8s/pyramid-ingress/30-register-job.yaml)
// is named "register-cameras" — matches what the console searches for.
const CAMERAS = {
  namespace: "pyramid-ingress",
  configMap: "cameras",
  yamlKey: "cameras.yaml",
  registerJobPrefix: "register-cameras",
} as const;

// ─── Demo-data ────────────────────────────────────────────────────────────────
// Deployment is "demo-producer" in namespace "demo-data"
// (k8s/demo-data/20-producer.yaml), NOT "demo-data-producer".
//
// Env var for tick rate: "TICK_SECONDS" (value is seconds as a string integer),
// NOT "TICK_RATE_MS".
// Env var for match probability: "MATCH_PROBABILITY" — matches the console.
// ConfigMap carrying env: "demo-producer-env".
const DEMO_DATA = {
  namespace: "demo-data",
  deployment: "demo-producer",
  envConfigMap: "demo-producer-env",
  tickSecondsEnv: "TICK_SECONDS",
  matchProbabilityEnv: "MATCH_PROBABILITY",
} as const;

// ─── S3 ──────────────────────────────────────────────────────────────────────
const S3 = {
  bucket: process.env.S3_BUCKET ?? "vss-video",
  endpoint: process.env.S3_ENDPOINT ?? "",
} as const;

// ─── Restartable components ───────────────────────────────────────────────────
// Maps console component IDs → { namespace, kind, name }.
// cosmos-reason2-8b is a StatefulSet (not Deployment).
// nim-preview has no Deployment in k8s/rtvi/ — flagged as ASSUMED.
export type ComponentKind = "Deployment" | "StatefulSet";

export interface ComponentSpec {
  namespace: string;
  kind: ComponentKind;
  name: string;
}

export const RESTARTABLE: Record<string, ComponentSpec> = {
  "alert-worker": {
    namespace: "alerts",
    kind: "Deployment",
    name: "alert-worker",
  },
  "rtvi-vlm": {
    namespace: "rtvi",
    kind: "Deployment",
    name: "rtvi-vlm",
  },
  "rtvi-embed": {
    namespace: "rtvi",
    kind: "Deployment",
    name: "rtvi-embed",
  },
  "sensor-ms": {
    namespace: "vst",
    kind: "Deployment",
    name: "sensor-ms",
  },
  "streamprocessing-ms": {
    namespace: "vst",
    kind: "Deployment",
    name: "streamprocessing-ms",
  },
  "vss-agent": {
    // k8s/agent/20-vss-agent.yaml — Deployment name is "vss-agent"
    namespace: "agent",
    kind: "Deployment",
    name: "vss-agent",
  },
  "demo-producer": {
    // Real name is demo-producer, not demo-data-producer
    namespace: "demo-data",
    kind: "Deployment",
    name: "demo-producer",
  },
  "cosmos-reason2-8b": {
    // StatefulSet in k8s/rtvi/30-nim-cosmos-reason2-8b.yaml
    namespace: "rtvi",
    kind: "StatefulSet",
    name: "cosmos-reason2-8b",
  },
  // ASSUMED: nim-preview deployment not found in k8s/rtvi/ manifests.
  // Operators must confirm the name at deploy time.
  "nim-preview": {
    namespace: "rtvi",
    kind: "Deployment",
    name: "nim-preview",
  },
};

// ─── Unified export ───────────────────────────────────────────────────────────
export const CLUSTER = {
  kafka: {
    brokers: KAFKA_BROKERS,
    topics: KAFKA_TOPICS,
  },
  redis: {
    url: REDIS_URL,
  },
  vst: {
    sensorUrl: VST_SENSOR_URL,
  },
  mediamtx: {
    apiUrl: MEDIAMTX_API_URL,
  },
  prometheus: {
    url: PROMETHEUS_URL,
  },
  alertWorker: {
    url: ALERT_WORKER_URL,
  },
  rtvi: RTVI,
  nim: {
    previewEndpoint: NIM_PREVIEW_ENDPOINT,
  },
  scenarios: SCENARIOS,
  alertsTuning: ALERTS_TUNING,
  cameras: CAMERAS,
  demoData: DEMO_DATA,
  s3: S3,
  restartable: RESTARTABLE,
} as const;
