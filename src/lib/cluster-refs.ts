import "server-only";

/**
 * cluster-refs.ts — single source of truth for all in-cluster service names,
 * ConfigMap names, Deployment names, env-var keys, and topic names used by
 * the console API routes.
 *
 * Every value that can vary between environments reads from process.env first,
 * so operators can override via k8s/console/11-configmap-env.yaml at deploy
 * time without touching the image.
 *
 * Helm layout: the upstream NVIDIA VSS Helm chart deploys everything into a
 * single namespace `vss-<profile>` (e.g. `vss-alerts`, `vss-base`).
 * Set VSS_NAMESPACE to match the deployed Helm release namespace.
 * SCALITY_BP_PROFILE is the companion that drives deploy-time rendering of
 * VSS_NAMESPACE=vss-<profile> into console-env — the app reads VSS_NAMESPACE
 * directly and never needs SCALITY_BP_PROFILE itself.
 *
 * Legacy layout (pre-Helm): set CONSOLE_LEGACY_NAMESPACES=1 to activate.
 * Under this flag the defaults revert to the legacy per-namespace layout
 * (vst / rtvi / agent / alerts).  Only needed against pre-Helm instances.
 *
 * Architecture note: the console does NOT use hostNetwork and always addresses
 * services via ClusterIP / headless-service DNS names.
 */

const LEGACY = process.env.CONSOLE_LEGACY_NAMESPACES === "1";

// ─── VSS namespace ────────────────────────────────────────────────────────────
// Helm: single namespace for every VSS component.
// Legacy: components split across vst / rtvi / agent / alerts.
const VSS_NS = process.env.VSS_NAMESPACE ?? "vss-base";

// ─── Kafka ────────────────────────────────────────────────────────────────────
// Helm:   kafka-kafka StatefulSet in vss-<profile> (Confluent Kafka, not Redpanda).
//         Service name verified on live cluster: kafka-kafka.vss-alerts.svc.cluster.local:9092
// Legacy: redpanda StatefulSet in namespace rtvi.
const KAFKA_BROKERS = LEGACY
  ? (process.env.KAFKA_BROKERS ?? "redpanda.rtvi.svc.cluster.local:9092")
  : (process.env.KAFKA_BROKERS ?? `kafka-kafka.${VSS_NS}.svc.cluster.local:9092`);

// Topic names differ between the legacy hand-authored manifests and the Helm
// chart. Every name is env-overridable so the operator can match the actual
// 3.2 deploy without a code change (the chart parameterizes topics per profile).
// 3.2 fact (chart): vision-llm-errors and vision-embed-errors DO exist;
// vision-embed-messages does NOT (embeddings flow on mdx-embed).
const KAFKA_TOPICS = LEGACY
  ? ({
      visionLlm: process.env.KAFKA_TOPIC_VISION_LLM ?? "vision-llm-messages",
      incidents: process.env.KAFKA_TOPIC_INCIDENTS ?? "vision-llm-events-incidents",
      visionLlmErrors: process.env.KAFKA_TOPIC_VISION_LLM_ERRORS ?? "vision-llm-errors",
      embedMessages: process.env.KAFKA_TOPIC_EMBED_MESSAGES ?? "vision-embed-messages",
      embedErrors: process.env.KAFKA_TOPIC_EMBED_ERRORS ?? "vision-embed-errors",
      demoData: process.env.KAFKA_TOPIC_DEMO_DATA ?? "vision-llm-messages",
    } as const)
  : ({
      visionLlm: process.env.KAFKA_TOPIC_VISION_LLM ?? "mdx-vlm",
      incidents: process.env.KAFKA_TOPIC_INCIDENTS ?? "mdx-vlm-incidents",
      visionLlmErrors: process.env.KAFKA_TOPIC_VISION_LLM_ERRORS ?? "vision-llm-errors",
      embedMessages: process.env.KAFKA_TOPIC_EMBED_MESSAGES ?? "vision-embed-messages",
      embedErrors: process.env.KAFKA_TOPIC_EMBED_ERRORS ?? "vision-embed-errors",
      demoData: process.env.KAFKA_TOPIC_DEMO_DATA ?? "mdx-vlm",
    } as const);

// ─── Redis ────────────────────────────────────────────────────────────────────
// Helm:   redis StatefulSet in vss-<profile>.
//         Service name verified on live cluster: redis.vss-alerts.svc.cluster.local:6379
// Legacy: redis Deployment in namespace vst.
const REDIS_URL = LEGACY
  ? (process.env.REDIS_URL ?? "redis://redis.vst.svc.cluster.local:6379")
  : (process.env.REDIS_URL ?? `redis://redis.${VSS_NS}.svc.cluster.local:6379`);

// ─── VIOS / sensor + streamprocessing ────────────────────────────────────────
// Helm service names verified on live cluster (2026-05-11):
//   vss-vios-sensor            port 30000 — HTTP sensor API
//   vss-vios-ingress           port 30888 — nginx ingress for sensor add
//   vss-vios-streamprocessing  ports 30001/30554
// Legacy: sensor-ms:30000, vst-ingress:30888, streamprocessing-ms:30001
//
// Helm VST sensor API path is /api/v1/sensor[...] — verified against a live
// vss-vios-sensor:30000 (returns the sensor array). The /api/v1/live/... form
// 404s on this build; the legacy sensor-ms keeps its own /live/ path.

const VST_SENSOR_URL = LEGACY
  ? (process.env.VST_SENSOR_URL ??
      "http://sensor-ms.vst.svc.cluster.local:30000/api/v1/live/sensor")
  : (process.env.VST_SENSOR_URL ??
      `http://vss-vios-sensor.${VSS_NS}.svc.cluster.local:30000/api/v1/sensor`);

const VST_SENSOR_LIST_URL = LEGACY
  ? (process.env.VST_SENSOR_LIST_URL ??
      "http://sensor-ms.vst.svc.cluster.local:30000/api/v1/live/sensor/list")
  : (process.env.VST_SENSOR_LIST_URL ??
      `http://vss-vios-sensor.${VSS_NS}.svc.cluster.local:30000/api/v1/sensor/list`);

const VST_SENSOR_ADD_URL = LEGACY
  ? (process.env.VST_SENSOR_ADD_URL ??
      "http://vst-ingress.vst.svc.cluster.local:30888/vst/api/v1/sensor/add")
  : (process.env.VST_SENSOR_ADD_URL ??
      `http://vss-vios-ingress.${VSS_NS}.svc.cluster.local:30888/vst/api/v1/sensor/add`);

const VST_PROXY_STREAM_ADD_URL =
  process.env.VST_PROXY_STREAM_ADD_URL ??
  (process.env.CONSOLE_RUNTIME === "docker"
    ? "http://127.0.0.1:30001/api/v1/proxy/stream/add"
    : "");

// Symmetric to proxy/stream/add: tears down the recording pipeline for a
// sensor (clears sensor_details.url, stops streamprocessing-ms recording)
// while leaving the sensor registered + live. Same streamprocessing-ms host
// as the add URL (only reachable from inside the VSS box on docker).
const VST_PROXY_STREAM_REMOVE_URL =
  process.env.VST_PROXY_STREAM_REMOVE_URL ??
  (process.env.CONSOLE_RUNTIME === "docker"
    ? "http://127.0.0.1:30001/api/v1/proxy/stream/remove"
    : "");

// VST ConfigMap + Deployment constants used by tuning/storage routes.
// Helm: ConfigMap vss-vios-sensor-configs with key vst_config.json
//       Deployment vss-vios-sensor
// Legacy: ConfigMap vst-config in namespace vst
// Storage API base (timelines + clip download). On Helm this is the nginx
// ingress at :30888/vst/api/v1 — clip download is
// GET /storage/file/{streamId}?startTime=..&endTime=..&container=mp4. The
// sensor-name→streamId resolution uses the sensor API base (VST_SENSOR_URL).
const VST_STORAGE_URL = LEGACY
  ? (process.env.VST_STORAGE_URL ??
      "http://vst-ingress.vst.svc.cluster.local:30888/vst/api/v1")
  : (process.env.VST_STORAGE_URL ??
      `http://vss-vios-ingress.${VSS_NS}.svc.cluster.local:30888/vst/api/v1`);

const VST = LEGACY
  ? ({
      namespace: "vst",
      configMap: "vst-config",
      configKey: "vst_config.json",
      sensorDeployment: "sensor-ms",
      streamProcessingDeployment: "streamprocessing-ms",
      sensorListUrl: VST_SENSOR_LIST_URL,
      sensorBase: VST_SENSOR_URL,
      storageBase: VST_STORAGE_URL,
      msUrl: "http://sensor-ms.vst.svc.cluster.local:5010",
    } as const)
  : ({
      namespace: VSS_NS,
      configMap: "vss-vios-sensor-configs",
      configKey: "vst_config.json",
      sensorDeployment: "vss-vios-sensor",
      streamProcessingDeployment: "vss-vios-streamprocessing",
      sensorListUrl: VST_SENSOR_LIST_URL,
      sensorBase: VST_SENSOR_URL,
      storageBase: VST_STORAGE_URL,
      msUrl: `http://vss-vios-sensor.${VSS_NS}.svc.cluster.local:5010`,
    } as const);

// ─── mediamtx ────────────────────────────────────────────────────────────────
const MEDIAMTX_API_URL =
  process.env.MEDIAMTX_API_URL ??
  `http://${process.env.CAMERA_SIM_HOST ?? "camera-sim-host"}:9997`;

// ─── Prometheus ───────────────────────────────────────────────────────────────
// Point at metalk8s-monitoring, NOT artesca-monitoring. ARTESCA ships two
// kube-prometheus-stack instances: artesca-monitoring (app/Zenko metrics, and
// its Prometheus CR has serviceMonitorSelector=null → it does NOT discover
// ServiceMonitors) and metalk8s-monitoring (node-exporter, kube-state-metrics,
// and the one that actually discovers our observability/ DCGM ServiceMonitor).
// The GPU metrics (DCGM_FI_DEV_GPU_*) only exist in metalk8s-monitoring's
// Prometheus — verified on ap-vss-val-4 (2 GPU series there, 0 in artesca-monitoring).
const PROMETHEUS_URL =
  process.env.PROMETHEUS_URL ??
  "http://prometheus-operated.metalk8s-monitoring.svc.cluster.local:9090";

// ─── Grafana (historical GPU graphs) ──────────────────────────────────────────
// ARTESCA's Grafana lives behind the :8443 shell-UI ingress. Dynamic per
// instance: explicit GRAFANA_URL wins, else derive from the node public IP the
// console already knows (OBJECTSTORE_ENDPOINT_IP) → https://<ip>:8443/. Empty
// when neither is set → the UI link is simply hidden.
const _GRAFANA_HOST_IP = process.env.OBJECTSTORE_ENDPOINT_IP ?? "";
const GRAFANA_URL =
  process.env.GRAFANA_URL ??
  (_GRAFANA_HOST_IP ? `https://${_GRAFANA_HOST_IP}:8443/` : "");
// Login surfaced to the operator. Grafana sits behind ARTESCA's :8443 SSO, so the
// login is the ARTESCA admin (same as the :8443 UI). Username is always shown.
// The password is only surfaced when GRAFANA_PASSWORD is set — local dev-console
// populates it from the node's Keycloak admin secret; the in-cluster ConfigMap
// leaves it unset (no admin secret baked into a cluster ConfigMap) and the UI
// shows the hint instead.
const GRAFANA_USER = process.env.GRAFANA_USER ?? "admin";
const GRAFANA_PASSWORD = process.env.GRAFANA_PASSWORD ?? "";
const GRAFANA_LOGIN_HINT =
  process.env.GRAFANA_LOGIN_HINT ??
  "ARTESCA admin (same login as the :8443 UI) → Monitoring → Grafana → \"ARTESCA+ VSS — GPU Metrics\"";

// ─── Alert bridge ────────────────────────────────────────────────────────────
// Helm:   vss-video-analytics-api Deployment in vss-<profile>, port 8081.
//         No HTTP health endpoint exposed by the console — only Kafka consumers.
// alert-worker Deployment + Service on :9100 — the scenario classification /
// dashboard layer. Legacy ran it in namespace "alerts"; the Helm path deploys
// it into VSS_NS via k8s/nvidia-vss-helm-overlay/50-alert-worker.yaml, reading
// the `scenarios` ConfigMap (see SCENARIOS below) the console patches.
const ALERT_WORKER_URL = LEGACY
  ? (process.env.ALERT_WORKER_URL ??
      "http://alert-worker.alerts.svc.cluster.local:9100")
  : (process.env.ALERT_WORKER_URL ??
      `http://alert-worker.${VSS_NS}.svc.cluster.local:9100`);

// The realtime alert-bridge (vss-alert-bridge) is the actual incident SOURCE on
// the Helm path: it produces incidents into Elasticsearch and serves them at
// GET /api/v1/realtime/incidents. vss-video-analytics-api (ALERT_WORKER_URL)
// has no /api/incidents endpoint — querying it 404s, which is why the console's
// Incidents page read 0. Incidents come from here.
const ALERT_BRIDGE_URL =
  process.env.ALERT_BRIDGE_URL ??
  `http://vss-alert-bridge.${VSS_NS}.svc.cluster.local:9080`;

// Realtime alert rules API — per-camera driver config (list/add/delete rules).
// Exposes GET/POST/DELETE /api/v1/realtime as documented in the VSS alert-bridge.
const ALERT_BRIDGE_REALTIME_URL =
  process.env.ALERT_BRIDGE_REALTIME_URL ??
  `${ALERT_BRIDGE_URL}/api/v1/realtime`;

// ─── RTVI / VLM ──────────────────────────────────────────────────────────────
// Helm chart layout verified on live cluster (2026-05-11):
//   Deployment:  vss-rtvi-vlm   in vss-<profile>
//   VLM_SYSTEM_PROMPT is a direct env var on the Deployment — no separate ConfigMap.
//   NIM tuning lives in ConfigMap nvidia-nemotron-nano-9b-v2-nim-env
//     keys: NIM_KVCACHE_PERCENT, NIM_MAX_MODEL_LEN, NIM_MAX_NUM_SEQS
//   NIM Deployment: nvidia-nemotron-nano-9b-v2 (Deployment, not StatefulSet)
//
// Legacy layout:
//   ConfigMap rtvi-runtime-env in namespace rtvi
//   NIM: StatefulSet cosmos-reason2-8b in namespace rtvi

const RTVI = LEGACY
  ? ({
      runtimeEnvCm: "rtvi-runtime-env",
      promptKey: "RTVI_VLM_SYSTEM_PROMPT",
      modelKey: "RTVI_VLM_OPENAI_MODEL_DEPLOYMENT_NAME",
      vlmDeployment: "rtvi-vlm",
      vlmNamespace: "rtvi",
      embedDeployment: process.env.RTVI_EMBED_DEPLOYMENT ?? "rtvi-embed",
      nimStatefulSet: process.env.NIM_TUNING_DEPLOYMENT ?? "cosmos-reason2-8b",
      nimNamespace: "rtvi",
      nimKvCacheKey: "VLM_NIM_KVCACHE_PERCENT",
      nimMaxModelLenKey: "NIM_MAX_MODEL_LEN",
      nimMaxNumSeqsKey: "NIM_MAX_NUM_SEQS",
      nimModelProfileKey: "NIM_MODEL_PROFILE",
    } as const)
  : ({
      /**
       * Helm path: VLM_SYSTEM_PROMPT is a direct env var on the vss-rtvi-vlm
       * Deployment.  The console patches it by updating the Deployment env
       * directly via the K8s API (patch deployment/vss-rtvi-vlm, path
       * /spec/template/spec/containers/0/env, not a ConfigMap patch).
       * runtimeEnvCm is set to "" to signal "no ConfigMap — patch Deployment".
       */
      runtimeEnvCm: "",
      promptKey: "VLM_SYSTEM_PROMPT",
      modelKey: "VIA_VLM_OPENAI_MODEL_DEPLOYMENT_NAME",
      vlmDeployment: "vss-rtvi-vlm",
      vlmNamespace: VSS_NS,
      // The rtvi-embed subchart is conditional (vss-rtvi-embed.enabled). When the
      // deploy enables it, set RTVI_EMBED_DEPLOYMENT=vss-rtvi-embed (separate
      // Cosmos Embed1 Deployment/Service:8000); default keeps the calibrated value.
      embedDeployment: process.env.RTVI_EMBED_DEPLOYMENT ?? "vss-rtvi-vlm",
      // VLM-tuning NIM. 3.2 VLM is the cosmos NIM (vlmNameSlug); set
      // NIM_TUNING_DEPLOYMENT=nvidia-cosmos-reason2-8b to tune the VLM rather
      // than the nemotron LLM NIM. Default keeps the calibrated value.
      nimStatefulSet: process.env.NIM_TUNING_DEPLOYMENT ?? "nvidia-nemotron-nano-9b-v2",
      nimNamespace: VSS_NS,
      nimKvCacheKey: "NIM_KVCACHE_PERCENT",
      nimMaxModelLenKey: "NIM_MAX_MODEL_LEN",
      nimMaxNumSeqsKey: "NIM_MAX_NUM_SEQS",
      nimModelProfileKey: "NIM_MODEL_PROFILE",
    } as const);

// NIM ConfigMap name for tuning (only relevant in Helm path).
// Legacy: tuning keys live in rtvi-runtime-env (no separate NIM ConfigMap).
const NIM_TUNING_CONFIG_MAP = LEGACY
  ? ""
  : (process.env.NIM_TUNING_CONFIG_MAP ?? "nvidia-nemotron-nano-9b-v2-nim-env");

const NIM_TUNING_NAMESPACE = LEGACY ? "rtvi" : VSS_NS;

// ─── NIM preview endpoint ─────────────────────────────────────────────────────
const NIM_PREVIEW_ENDPOINT = LEGACY
  ? (process.env.NIM_PREVIEW_ENDPOINT ??
      "http://nvila-lite-preview.rtvi.svc.cluster.local:8000")
  : (process.env.NIM_PREVIEW_ENDPOINT ??
      `http://nvila-lite-preview.${VSS_NS}.svc.cluster.local:8000`);

// ─── Scenarios ────────────────────────────────────────────────────────────────
// Legacy: ConfigMap "scenarios" in namespace "alerts".
// Helm: no built-in scenarios ConfigMap — scenarios are managed via the
// vss-video-analytics-api config.  The console keeps the pyramid-ingress
// ConfigMap for operator-defined scenarios applied alongside the Helm chart.
// Namespace still "alerts" under legacy; "pyramid-ingress" or VSS_NS under Helm.
// Using pyramid-ingress as the persisted home for operator scenarios (unchanged).
const SCENARIOS = LEGACY
  ? ({
      namespace: "alerts",
      configMap: "scenarios",
      yamlKey: "scenarios.yaml",
      alertWorkerDeployment: "alert-worker",
    } as const)
  : ({
      namespace: VSS_NS,
      configMap: "scenarios",
      yamlKey: "scenarios.yaml",
      alertWorkerDeployment: "alert-worker",
    } as const);

// ─── Alerts tuning ────────────────────────────────────────────────────────────
// Legacy: ConfigMap "alerts-runtime-env" in namespace "alerts".
// Helm: no equivalent ConfigMap — vss-video-analytics-api has its own config.
// Keep the struct shape for API route compatibility; Helm path points to vss-<profile>.
const ALERTS_TUNING = LEGACY
  ? ({
      namespace: "alerts",
      configMap: "alerts-runtime-env",
      cooldownKey: "COOLDOWN_SECONDS",
      slackConfiguredKey: "SLACK_WEBHOOK_CONFIGURED",
    } as const)
  : ({
      namespace: VSS_NS,
      configMap: "vss-video-analytics-api-config",
      cooldownKey: "COOLDOWN_SECONDS",
      slackConfiguredKey: "SLACK_WEBHOOK_CONFIGURED",
    } as const);

// ─── Cameras / pyramid-ingress ────────────────────────────────────────────────
// Unchanged — operator-authored pyramid-ingress namespace persists alongside Helm.
const CAMERAS = {
  namespace: "pyramid-ingress",
  configMap: "cameras",
  yamlKey: "cameras.yaml",
  registerJobPrefix: "register-cameras",
} as const;

// ─── Demo-data ────────────────────────────────────────────────────────────────
// Unchanged — demo-data namespace is operator-authored, not part of the Helm chart.
const DEMO_DATA = {
  namespace: "demo-data",
  deployment: "demo-producer",
  envConfigMap: "demo-producer-env",
  tickSecondsEnv: "TICK_SECONDS",
  matchProbabilityEnv: "MATCH_PROBABILITY",
  dockerContainer: process.env.DEMO_PRODUCER_CONTAINER ?? "demo-producer",
} as const;

// ─── S3 ──────────────────────────────────────────────────────────────────────
// Three-bucket model: recordings (VST writes), alert-clips (materializer
// writes + console replay reads), agent-corpus (optional forensic Q&A).
// Each bucket is independently configurable via env vars injected from the
// objectstore-creds Secret + console-env ConfigMap.
const S3 = {
  endpoint: process.env.OBJECTSTORE_ENDPOINT ?? process.env.S3_ENDPOINT ?? "",
  region: process.env.OBJECTSTORE_REGION ?? "us-east-1",
  buckets: {
    recordings:
      process.env.OBJECTSTORE_RECORDINGS_BUCKET ?? "nvidia-vss-recordings",
    alertClips:
      process.env.OBJECTSTORE_ALERT_CLIPS_BUCKET ?? "nvidia-vss-alert-clips",
    agentCorpus:
      process.env.OBJECTSTORE_AGENT_CORPUS_BUCKET ?? "nvidia-vss-agent-corpus",
  },
} as const;

// ─── Secrets namespace ────────────────────────────────────────────────────────
// Helm: all secrets live in vss-<profile>.
// Legacy: secrets scattered across rtvi / alerts / console namespaces.
const SECRETS_NS = LEGACY ? undefined : VSS_NS;

// ─── RTVI-CV (perception / MV3DT) ────────────────────────────────────────────
// Warehouse-MV3DT profile perception+embeddings microservice (object detection,
// tracking, behavior analytics, text embeddings). REST API at :9000 /api/v1.
// NOT deployed on the alerts/base showroom profile — opt-in via RTVI_CV_* env.
const RTVI_CV_SERVICE = process.env.RTVI_CV_SERVICE ?? "vss-rtvi-cv-mv3dt";
const RTVI_CV_NS = process.env.RTVI_CV_NAMESPACE ?? VSS_NS;
const RTVI_CV_PORT = Number(process.env.RTVI_CV_PORT ?? 9000);
const RTVI_CV = {
  enabled:
    process.env.RTVI_CV_ENABLED === "1" ||
    !!process.env.RTVI_CV_SERVICE ||
    !!process.env.RTVI_CV_ENDPOINT,
  service: RTVI_CV_SERVICE,
  namespace: RTVI_CV_NS,
  port: RTVI_CV_PORT,
  apiBase: "/api/v1",
  endpoint:
    process.env.RTVI_CV_ENDPOINT ??
    `http://${RTVI_CV_SERVICE}.${RTVI_CV_NS}.svc.cluster.local:${RTVI_CV_PORT}`,
  healthPath: process.env.RTVI_CV_HEALTH_PATH ?? "/api/v1/health/ready",
  embeddingsPath: "/api/v1/generate_text_embeddings",
} as const;

// ─── Restartable components ───────────────────────────────────────────────────
// Maps console component IDs → { namespace, kind, name }.
// Helm: all VSS components in VSS_NS; NIM is a Deployment (not StatefulSet).
export type ComponentKind = "Deployment" | "StatefulSet";

export interface ComponentSpec {
  namespace: string;
  kind: ComponentKind;
  name: string;
}

export const RESTARTABLE: Record<string, ComponentSpec> = LEGACY
  ? {
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
      "nvidia-vss-agent": {
        namespace: "agent",
        kind: "Deployment",
        name: "nvidia-vss-agent",
      },
      "demo-producer": {
        namespace: "demo-data",
        kind: "Deployment",
        name: "demo-producer",
      },
      "cosmos-reason2-8b": {
        namespace: "rtvi",
        kind: "StatefulSet",
        name: "cosmos-reason2-8b",
      },
      "nim-preview": {
        namespace: "rtvi",
        kind: "Deployment",
        name: "nvila-lite-preview",
      },
    }
  : {
      "vss-video-analytics-api": {
        namespace: VSS_NS,
        kind: "Deployment",
        name: "vss-video-analytics-api",
      },
      "vss-rtvi-vlm": {
        namespace: VSS_NS,
        kind: "Deployment",
        name: "vss-rtvi-vlm",
      },
      "vss-vios-sensor": {
        namespace: VSS_NS,
        kind: "Deployment",
        name: "vss-vios-sensor",
      },
      "vss-vios-streamprocessing": {
        namespace: VSS_NS,
        kind: "StatefulSet",
        name: "vss-vios-streamprocessing",
      },
      "vss-agent": {
        namespace: VSS_NS,
        kind: "Deployment",
        name: "vss-agent",
      },
      "demo-producer": {
        namespace: "demo-data",
        kind: "Deployment",
        name: "demo-producer",
      },
      "nvidia-nemotron-nano-9b-v2": {
        namespace: VSS_NS,
        kind: "Deployment",
        name: "nvidia-nemotron-nano-9b-v2",
      },
      "nim-preview": {
        namespace: VSS_NS,
        kind: "Deployment",
        name: "nvila-lite-preview",
      },
      ...(RTVI_CV.enabled
        ? {
            [RTVI_CV_SERVICE]: {
              namespace: RTVI_CV_NS,
              kind: "Deployment" as const,
              name: RTVI_CV_SERVICE,
            },
          }
        : {}),
    };

// ─── Unified export ───────────────────────────────────────────────────────────
export const CLUSTER = {
  /** True when running against the legacy pre-Helm namespace layout. */
  legacy: LEGACY,
  /** The active VSS Helm release namespace (e.g. "vss-alerts"). */
  vssNamespace: VSS_NS,
  kafka: {
    brokers: KAFKA_BROKERS,
    topics: KAFKA_TOPICS,
  },
  redis: {
    url: REDIS_URL,
  },
  vst: {
    sensorUrl: VST_SENSOR_URL,
    sensorAddUrl: VST_SENSOR_ADD_URL,
    proxyStreamAddUrl: VST_PROXY_STREAM_ADD_URL,
    proxyStreamRemoveUrl: VST_PROXY_STREAM_REMOVE_URL,
    ...VST,
  },
  mediamtx: {
    apiUrl: MEDIAMTX_API_URL,
  },
  prometheus: {
    url: PROMETHEUS_URL,
  },
  grafana: {
    url: GRAFANA_URL,
    user: GRAFANA_USER,
    password: GRAFANA_PASSWORD,
    loginHint: GRAFANA_LOGIN_HINT,
  },
  alertWorker: {
    url: ALERT_WORKER_URL,
  },
  alertBridge: {
    url: ALERT_BRIDGE_URL,
    realtimeUrl: ALERT_BRIDGE_REALTIME_URL,
  },
  rtvi: {
    ...RTVI,
    /** NIM tuning ConfigMap name (Helm path only; empty string in legacy path). */
    nimTuningConfigMap: NIM_TUNING_CONFIG_MAP,
    nimTuningNamespace: NIM_TUNING_NAMESPACE,
  },
  nim: {
    previewEndpoint: NIM_PREVIEW_ENDPOINT,
  },
  rtviCv: RTVI_CV,
  scenarios: SCENARIOS,
  alertsTuning: ALERTS_TUNING,
  cameras: CAMERAS,
  demoData: DEMO_DATA,
  s3: S3,
  restartable: RESTARTABLE,
  /**
   * Namespace for VSS-related K8s Secrets (ngc-secret, objectstore-creds).
   * Helm: same as vssNamespace. Legacy: undefined (per-component namespaces).
   */
  secretsNamespace: SECRETS_NS,
} as const;
