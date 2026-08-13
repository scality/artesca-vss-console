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
//         The FQDN here is necessary but not sufficient: the chart makes the
//         broker ADVERTISE the bare `kafka-kafka`, so a client outside the VSS
//         namespace bootstraps on this address, is handed the bare name back in
//         the cluster metadata, and cannot resolve it. The overlay Job
//         k8s/nvidia-vss-helm-overlay/70-kafka-advertised-listener-patch-job.yaml
//         re-advertises the FQDN — without it, no console consumer ever
//         connects (ISVD-506).
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
    } as const)
  : ({
      visionLlm: process.env.KAFKA_TOPIC_VISION_LLM ?? "mdx-vlm",
      incidents: process.env.KAFKA_TOPIC_INCIDENTS ?? "mdx-vlm-incidents",
      visionLlmErrors: process.env.KAFKA_TOPIC_VISION_LLM_ERRORS ?? "vision-llm-errors",
      embedMessages: process.env.KAFKA_TOPIC_EMBED_MESSAGES ?? "vision-embed-messages",
      embedErrors: process.env.KAFKA_TOPIC_EMBED_ERRORS ?? "vision-embed-errors",
    } as const);

// ─── Redis ────────────────────────────────────────────────────────────────────
// Helm:   redis StatefulSet in vss-<profile>.
//         Service name verified on live cluster: redis.vss-alerts.svc.cluster.local:6379
// Legacy: redis Deployment in namespace vst.
const REDIS_URL = LEGACY
  ? (process.env.REDIS_URL ?? "redis://redis.vst.svc.cluster.local:6379")
  : (process.env.REDIS_URL ?? `redis://redis.${VSS_NS}.svc.cluster.local:6379`);
// Pod label the redis probe execs `redis-cli` into.
// Helm: the redis StatefulSet pods carry app.kubernetes.io/name=redis. Legacy: app=redis.
const REDIS_POD_LABEL = LEGACY
  ? (process.env.REDIS_POD_LABEL ?? "app=redis")
  : (process.env.REDIS_POD_LABEL ?? "app.kubernetes.io/name=redis");

// ─── Postgres (VST metadata DB) ───────────────────────────────────────────────
// Pod label the postgres probe execs `pg_isready`/`psql` into.
// Helm: vss-vios-postgres StatefulSet → app.kubernetes.io/name=vss-vios-postgres. Legacy: app=postgres.
const POSTGRES_POD_LABEL = LEGACY
  ? (process.env.POSTGRES_POD_LABEL ?? "app=postgres")
  : (process.env.POSTGRES_POD_LABEL ?? "app.kubernetes.io/name=vss-vios-postgres");
const POSTGRES_USER = process.env.POSTGRES_USER ?? "vst";

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
  (LEGACY
    ? ""
    : `http://vss-vios-streamprocessing.${VSS_NS}.svc.cluster.local:30001/api/v1/proxy/stream/add`);

// Symmetric to proxy/stream/add: tears down the recording pipeline for a
// sensor (clears sensor_details.url, stops streamprocessing-ms recording)
// while leaving the sensor registered + live. Same streamprocessing-ms host
// as the add URL (only reachable from inside the VSS box on docker).
const VST_PROXY_STREAM_REMOVE_URL =
  process.env.VST_PROXY_STREAM_REMOVE_URL ??
  (LEGACY
    ? ""
    : `http://vss-vios-streamprocessing.${VSS_NS}.svc.cluster.local:30001/api/v1/proxy/stream/remove`);

// VST ConfigMap + Deployment constants used by tuning/storage routes.
// Helm: sensor and streamprocessing each mount their OWN ConfigMap — they are
//       NOT shared, despite carrying the identical vst_config.json schema.
//       Verified on live pyramid-showroom cluster (2026-07-01): patching only
//       vss-vios-sensor-configs left streamprocessing's recorder settings
//       (recorder_enable_frame_drop, etc.) unchanged because it reads
//       vss-vios-streamprocessing-configs instead. A tuning PATCH must write
//       both ConfigMaps to keep them in sync (they're expected to be
//       identical copies of the same rendered template, not a field-level
//       split — the Helm chart just gives each component its own copy so
//       restarting one doesn't require restarting the other).
//       streamprocessing is also a StatefulSet on this chart version, not a
//       Deployment — rollout restart must use the matching kind per
//       component (verified via `kubectl get deploy,statefulset`).
// Legacy: ONE ConfigMap vst-config in namespace vst, shared by both
//         Deployments (sensor-ms, streamprocessing-ms) — confirmed against
//         k8s/nvidia-vss/vst/{30-sensor-ms,31-streamprocessing-ms}.yaml.
// Storage API base (timelines + clip download). On Helm this is the nginx
// ingress at :30888/vst/api/v1 — clip download is
// GET /storage/file/{streamId}?startTime=..&endTime=..&container=mp4. The
// sensor-name→streamId resolution uses the sensor API base (VST_SENSOR_URL).
const VST_STORAGE_URL = LEGACY
  ? (process.env.VST_STORAGE_URL ??
      "http://vst-ingress.vst.svc.cluster.local:30888/vst/api/v1")
  : (process.env.VST_STORAGE_URL ??
      `http://vss-vios-ingress.${VSS_NS}.svc.cluster.local:30888/vst/api/v1`);

// Origin (scheme+host+port, no path) of the service above — the /api/media
// proxy forwards a snapshot/clip's full path (e.g.
// "/vst/storage/temp_files/<file>.jpg", as stamped by the agent) onto this
// origin, since VST serves that webroot on the same ingress as the storage
// API. Derived from VST_STORAGE_URL rather than duplicated so the two never
// drift; override only if the webroot ever moves to a different service.
const VST_MEDIA_ORIGIN =
  process.env.VST_MEDIA_ORIGIN ?? new URL(VST_STORAGE_URL).origin;

const VST = LEGACY
  ? ({
      namespace: "vst",
      sensorConfigMap: process.env.VST_SENSOR_CONFIGMAP ?? "vst-config",
      streamProcessingConfigMap:
        process.env.VST_STREAMPROCESSING_CONFIGMAP ?? "vst-config",
      configKey: "vst_config.json",
      sensorDeployment: "sensor-ms",
      sensorKind: "Deployment" as const,
      streamProcessingDeployment: "streamprocessing-ms",
      streamProcessingKind: "Deployment" as const,
      sensorListUrl: VST_SENSOR_LIST_URL,
      sensorBase: VST_SENSOR_URL,
      storageBase: VST_STORAGE_URL,
      msUrl: "http://sensor-ms.vst.svc.cluster.local:5010",
    } as const)
  : ({
      namespace: VSS_NS,
      sensorConfigMap:
        process.env.VST_SENSOR_CONFIGMAP ?? "vss-vios-sensor-configs",
      streamProcessingConfigMap:
        process.env.VST_STREAMPROCESSING_CONFIGMAP ??
        "vss-vios-streamprocessing-configs",
      configKey: "vst_config.json",
      sensorDeployment: "vss-vios-sensor",
      sensorKind: "Deployment" as const,
      streamProcessingDeployment: "vss-vios-streamprocessing",
      streamProcessingKind:
        (process.env.VST_STREAMPROCESSING_KIND as
          | "Deployment"
          | "StatefulSet"
          | undefined) ?? "StatefulSet",
      sensorListUrl: VST_SENSOR_LIST_URL,
      sensorBase: VST_SENSOR_URL,
      storageBase: VST_STORAGE_URL,
      msUrl: `http://vss-vios-sensor.${VSS_NS}.svc.cluster.local:5010`,
    } as const);

// ─── mediamtx ────────────────────────────────────────────────────────────────
const CAMERA_SIM_HOST_RAW = process.env.CAMERA_SIM_HOST ?? "";
const MEDIAMTX_API_URL =
  process.env.MEDIAMTX_API_URL ??
  `http://${CAMERA_SIM_HOST_RAW || "camera-sim-host"}:9997`;
// mediamtx is an OPTIONAL camera-sim RTSP source — deployments using real IP
// cameras (e.g. Pyramid) leave CAMERA_SIM_HOST unset or a `<...>` placeholder.
// Treat those as "not configured" so the probe is skipped instead of failing on
// an unparseable URL.
const MEDIAMTX_CONFIGURED =
  !!process.env.MEDIAMTX_API_URL ||
  (CAMERA_SIM_HOST_RAW !== "" &&
    CAMERA_SIM_HOST_RAW !== "camera-sim-host" &&
    !CAMERA_SIM_HOST_RAW.includes("<"));

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

// RT-VLM OpenAI-compatible model list. Used to resolve the model id a rule must
// carry: the realtime-alert-rules CM ships a build-versioned name (and can hold
// a placeholder like "resolved-live-from-vlm"), and the alert-bridge rejects a
// name the VLM doesn't serve with 400 "No such model" — surfacing to the console
// only as a 502, leaving the camera silently un-ingested.
const RTVI_VLM_MODELS_URL =
  process.env.RTVI_VLM_MODELS_URL ??
  `http://vss-rtvi-vlm.${VSS_NS}.svc.cluster.local:8000/v1/models`;

// ─── VSS Agent (chat) ─────────────────────────────────────────────────────────
// Helm: vss-agent Deployment/Service in vss-<profile>, OpenAI-compatible
// /chat endpoint on :8000. Same resolution /api/chat/route.ts already used
// ad hoc — mirrored here so other agent-facing collectors (e.g. the /agent
// page's reachability probe) read the canonical value instead of
// re-deriving it.
const VSS_AGENT_URL =
  process.env.VSS_AGENT_URL ??
  `http://vss-agent.${VSS_NS}.svc.cluster.local:8000`;

// The agent stamps snapshot/clip URLs with this literal host:port (its own
// VST_EXTERNAL_URL / VSS_AGENT_EXTERNAL_URL env — "vss-agent:8000", the short
// in-cluster DNS name), which is distinct from VSS_AGENT_URL above (the long
// form the console itself uses to call the agent) and unreachable from a
// browser either way. /api/chat/route.ts rewrites this prefix to the
// console's own same-origin /api/media proxy before a reply reaches the
// browser, so snapshot images and clip videos render/play with one click
// instead of showing a dead internal link. Configurable in case a future
// chart revision changes the agent's stamped host.
const VSS_AGENT_MEDIA_HOST =
  process.env.VSS_AGENT_MEDIA_HOST ?? "vss-agent:8000";

// Master switch for the media URL rewrite + /api/media proxy. Set
// VSS_MEDIA_PROXY_ENABLED="0" to fall back to raw (browser-unreachable, but
// easier to debug against) agent URLs.
const MEDIA_PROXY_ENABLED = process.env.VSS_MEDIA_PROXY_ENABLED !== "0";

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
      // VLM-tuning target. On the "alerts" profile the VLM (cosmos) runs inside
      // the vss-rtvi-vlm Deployment itself — there is no separate NIM workload.
      // The tunables are env vars on that Deployment, so nimStatefulSet points at
      // vss-rtvi-vlm and the keys are the chart's real env names.
      nimStatefulSet: process.env.NIM_TUNING_DEPLOYMENT ?? "vss-rtvi-vlm",
      nimNamespace: VSS_NS,
      nimKvCacheKey: "VLLM_GPU_MEMORY_UTILIZATION",
      nimMaxModelLenKey: "NIM_MAX_MODEL_LEN",
      nimMaxNumSeqsKey: "VLM_BATCH_SIZE",
      nimModelProfileKey: "NIM_MODEL_PROFILE",
    } as const);

// NIM ConfigMap name for tuning (only relevant in Helm path).
// Legacy: tuning keys live in rtvi-runtime-env (no separate NIM ConfigMap).
// On the "alerts" profile there is no separate NIM tuning ConfigMap — the VLM
// tunables are env vars on the vss-rtvi-vlm Deployment. Empty string signals the
// rtvi tuning route to read/write the Deployment env directly.
const NIM_TUNING_CONFIG_MAP = LEGACY
  ? ""
  : (process.env.NIM_TUNING_CONFIG_MAP ?? "");

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

// ─── S3 ──────────────────────────────────────────────────────────────────────
// Three-bucket model: recordings (VST writes), alert-clips (materializer
// writes + console replay reads), agent-corpus (optional forensic Q&A).
// Each bucket is independently configurable via env vars injected from the
// objectstore-creds Secret + console-env ConfigMap.
// Operator-configured storage capacity (bytes) shown in the Overview
// "Total Size" KPI. 0 = unset/unknown (KPI renders used-only).
const S3_CAPACITY_BYTES = Number(process.env.STORAGE_CAPACITY_BYTES ?? 0) || 0;

const S3 = {
  endpoint: process.env.OBJECTSTORE_ENDPOINT ?? process.env.S3_ENDPOINT ?? "",
  region: process.env.OBJECTSTORE_REGION ?? "us-east-1",
  capacityBytes: S3_CAPACITY_BYTES,
  buckets: {
    recordings:
      process.env.OBJECTSTORE_RECORDINGS_BUCKET ?? "nvidia-vss-recordings",
    alertClips:
      process.env.OBJECTSTORE_ALERT_CLIPS_BUCKET ?? "nvidia-vss-alert-clips",
    agentCorpus:
      process.env.OBJECTSTORE_AGENT_CORPUS_BUCKET ?? "nvidia-vss-agent-corpus",
  },
} as const;

// ─── KV-cache demo (ISVD-331 Phase C) ────────────────────────────────────────
// vLLM+LMCache OpenAI-compatible completions endpoint (namespace kvcache-demo)
// offloading KV blocks to an ARTESCA S3 bucket. Backs the /kvcache page's LIVE
// mode: GET /health on vllmUrl is the availability probe; the bucket is listed
// with the same S3 client (aws.ts/s3.ts) the console already uses for the
// objectstore-creds Secret — no separate credentials needed.
const KVCACHE = {
  vllmUrl:
    process.env.KVCACHE_VLLM_URL ??
    "http://vllm-lmcache.kvcache-demo.svc.cluster.local:8000",
  bucket: process.env.KVCACHE_BUCKET ?? "llm-kvcache-poc",
  model: process.env.KVCACHE_MODEL ?? "Qwen/Qwen2.5-1.5B-Instruct",
} as const;

// ─── Recording auto-heal (guarded re-arm on stalled VST recorder) ───────────
// The VST cloud recorder can silently stall — sessions stay alive but stop
// producing segments while the source/VLM pipeline is fine (root-caused
// 2026-07-04). Detection: probeRecording (recording-health.ts). Recovery:
// recoverStalledRecording (reconcile/recording-recovery.ts) re-arms the
// sensor (delete+re-add, same rtspUrl) after a sustained stall, gated by a
// cooldown + attempt cap + per-cycle batch cap. See
// docs/superpowers/specs/2026-07-04-vss-recording-recovery-design.md.
const RECORDING = {
  /** Master switch for the reconcile loop's recovery pass. Set "0" to disable. */
  enabled: process.env.RECORDING_AUTOHEAL_ENABLED !== "0",
  /** How long a sensor must read not-recording before it's eligible for a re-arm. */
  stallThresholdMs: Number(process.env.RECORDING_STALL_THRESHOLD_MS) || 300_000,
  /** Minimum time between re-arm attempts on the same sensor. */
  rearmCooldownMs: Number(process.env.RECORDING_REARM_COOLDOWN_MS) || 600_000,
  /** Stop re-arming (mark degraded) once this many attempts have been made. */
  rearmMaxAttempts: Number(process.env.RECORDING_REARM_MAX_ATTEMPTS) || 3,
  /** Cap on re-arms fired within a single reconcile pass. */
  rearmMaxPerCycle: Number(process.env.RECORDING_REARM_MAX_PER_CYCLE) || 1,
  /** Master switch for the pod-restart escalation (streamprocessing rollout) when
   *  many previously-recording sensors stall at once (per-sensor re-arm can't fix a
   *  pod-global recorder wedge). Set "0" to disable escalation only (per-sensor re-arm stays on). */
  escalateEnabled: process.env.RECORDING_ESCALATE_ENABLED !== "0",
  /** Min count of recoverable-stalled sensors (were recording, now not) that triggers a restart.
   *  Keep this ABOVE the number of permanently-offline cameras in the deployment so their
   *  perpetual not-recording state never triggers a restart on its own. */
  escalateMinStalled: Number(process.env.RECORDING_ESCALATE_MIN_STALLED) || 3,
  /** Min time between escalation restarts. */
  escalateCooldownMs: Number(process.env.RECORDING_ESCALATE_COOLDOWN_MS) || 300_000,
  /** Cap on escalation restarts before giving up (then per-sensor degraded stands). */
  escalateMaxRestarts: Number(process.env.RECORDING_ESCALATE_MAX_RESTARTS) || 2,
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

// ─── Caption-indexer (semantic search) ───────────────────────────────────────
// Python worker that indexes VLM incident captions into Qdrant and serves
// POST /search. The console is a thin proxy over it — Qdrant is never
// addressed directly from the console.
// Service: vss-caption-indexer.<vss-ns>.svc.cluster.local:8080
// Override: VSS_SEARCH_URL
const SEARCH_URL =
  process.env.VSS_SEARCH_URL ??
  `http://vss-caption-indexer.${VSS_NS}.svc.cluster.local:8080`;

// ─── TTS (on-box NVIDIA Magpie NIM) ───────────────────────────────────────────
// On-box, sovereign text-to-speech for the chat's spoken replies. HTTP API:
// POST /v1/audio/synthesize (multipart language/text/voice -> WAV),
// GET /v1/audio/list_voices. The console /api/tts proxies it; the /chat voice
// selector offers it alongside the browser voices. Override: VSS_TTS_URL.
const TTS_URL =
  process.env.VSS_TTS_URL ?? `http://magpie-tts.${VSS_NS}.svc.cluster.local:9000`;
const TTS_ENABLED = process.env.VSS_TTS_ENABLED !== "0";
const TTS_VOICE = process.env.VSS_TTS_VOICE ?? "Magpie-Multilingual.EN-US.Aria";
const TTS_LANGUAGE = process.env.VSS_TTS_LANGUAGE ?? "en-US";

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
    podLabel: REDIS_POD_LABEL,
  },
  postgres: {
    podLabel: POSTGRES_POD_LABEL,
    user: POSTGRES_USER,
  },
  vst: {
    sensorUrl: VST_SENSOR_URL,
    sensorAddUrl: VST_SENSOR_ADD_URL,
    proxyStreamAddUrl: VST_PROXY_STREAM_ADD_URL,
    proxyStreamRemoveUrl: VST_PROXY_STREAM_REMOVE_URL,
    /** Origin the /api/media proxy forwards snapshot/clip paths onto. */
    mediaOrigin: VST_MEDIA_ORIGIN,
    /** The recorder's own config document — cloud_storage_* lives here, written
     *  at deploy time from the objectstore-creds Secret. Read (never written)
     *  by the storage preflight, which exercises those credentials so a stale
     *  endpoint or revoked key is reported instead of silently killing every
     *  recording. */
    recorderConfig: {
      namespace: VSS_NS,
      configMap:
        process.env.VST_RECORDER_CONFIG_MAP ?? "vss-vios-streamprocessing-configs",
      key: process.env.VST_RECORDER_CONFIG_KEY ?? "vst_config.json",
    },
    ...VST,
  },
  /** Enables the /api/media proxy + chat media-URL rewrite (config: VSS_MEDIA_PROXY_ENABLED). */
  mediaProxyEnabled: MEDIA_PROXY_ENABLED,
  mediamtx: {
    apiUrl: MEDIAMTX_API_URL,
    /** False when no camera-sim host is set (real-camera deployments) — skip the probe. */
    configured: MEDIAMTX_CONFIGURED,
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
    /** ConfigMap holding the desired realtime-rule set (rules.json) that the
     *  vlm-stream-reconciler converges from. Sampling tuning is written here. */
    rulesConfigMap: process.env.REALTIME_RULES_CM ?? "realtime-alert-rules",
    rulesNamespace: VSS_NS,
    /** RT-VLM /v1/models — the authority on which model id a rule may carry. */
    vlmModelsUrl: RTVI_VLM_MODELS_URL,
  },
  agent: {
    /** vss-agent's OpenAI-compatible base URL — /chat and /health hang off this. */
    url: VSS_AGENT_URL,
    /** Host:port prefix the agent stamps into snapshot/clip URLs (browser-unreachable as-is). */
    mediaHost: VSS_AGENT_MEDIA_HOST,
    /** ConfigMap holding the agent's runtime config (workflow.prompt, workflow.max_iterations).
     *  Override via AGENT_CONFIG_MAP env if the Helm chart changes the name. */
    configMap: process.env.AGENT_CONFIG_MAP ?? "vss-agent-config",
    /** Key within the ConfigMap that holds the YAML config document. */
    configKey: process.env.AGENT_CONFIG_KEY ?? "config.yml",
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
  s3: S3,
  /** vLLM+LMCache KV-cache demo backend (ISVD-331 Phase C) — /kvcache page LIVE mode. */
  kvcache: KVCACHE,
  restartable: RESTARTABLE,
  search: {
    /** POST /search endpoint on the vss-caption-indexer worker. */
    url: SEARCH_URL,
  },
  tts: {
    /** On-box Magpie TTS NIM base URL (/v1/audio/synthesize, /v1/audio/list_voices). */
    url: TTS_URL,
    /** Master switch for the /api/tts proxy (env VSS_TTS_ENABLED="0" to disable). */
    enabled: TTS_ENABLED,
    /** Default on-box voice name. */
    voice: TTS_VOICE,
    /** Synthesis language code. */
    language: TTS_LANGUAGE,
  },
  /**
   * Namespace for VSS-related K8s Secrets (ngc-secret, objectstore-creds).
   * Helm: same as vssNamespace. Legacy: undefined (per-component namespaces).
   */
  secretsNamespace: SECRETS_NS,
  recording: RECORDING,
} as const;
