# Console — development context

The **console** is the in-cluster post-install operator UI for the ARTESCA+ VSS stack. Next.js 16, port **:8800**, runs as a K8s pod in namespace `console` (manifests at [`../k8s/console/`](../k8s/console/)). Distinct from [`../deployer/`](../deployer/) on :5002, which is laptop-side pre-install provisioning — the console assumes the cluster is up and running.

For the platform substrate, see the top-level [`CLAUDE.md`](../CLAUDE.md). Design rationale + page spec (the operator-facing intent of each page): [`../docs/console-design.md`](../docs/console-design.md).

## Page tree

13 pages, all server components by default; client components are scoped to interactive bits (forms, auto-refresh).

| Page | Purpose |
| ---- | ------- |
| `/` | Overview KPIs (cluster baseline, pod summaries, NIM health, recent incidents). Auto-refreshes every 5s via `OverviewAutoRefresh` (client) → `/api/status/overview`. A **reachability strip** (`ConnectivityStrip` → `/api/diagnostics/connectivity`, polled every 5s) shows per-backend console→cluster reachability — K8s API, Prometheus, camera-sim (mediamtx), Kafka, S3, and the **alert-bridge incidents source** (`GET /api/v1/realtime/incidents`, the path the Incidents page depends on); each probe is independent and fail-soft. The GPUs section surfaces a **Grafana access card** (URL + user + password in clear) linking to ARTESCA's `:8443` Grafana for historical GPU graphs — shown only when `CLUSTER.grafana.url` is set. |
| `/topology` | Single-frame path diagram (camera-sim → VST → RTVI VLM → Agent → S3) with per-component health pulled from `/api/pods`. |
| `/incidents` | Incident timeline. Visible in **kiosk mode** at `?mode=kiosk` (full-screen, no chrome — for the showroom display). |
| `/cameras` | Camera registration UI. Writes to `pyramid-ingress` ConfigMap `cameras` + GCS canonical at `gs://scality-isv-labs-config/cameras/<vss-instance>.json`. |
| `/scenarios` | Alert-keyword scenarios. ConfigMap `scenarios` in ns `alerts`; GCS canonical at `scenarios/<vss-instance>.json`. |
| `/prompt` | VLM system prompt + model deployment-name swap. Writes to ConfigMap `rtvi-runtime-env`. |
| `/tuning` | Knobs for VST (recording sink), alerts (cooldown, slack-configured), and the VLM inference path — 7 knobs split across ConfigMap (`max_num_seqs`, `kv_cache_percent`, `max_model_len`, `NIM_MODEL_PROFILE`) and the `rtvi-vlm` Deployment env (`NIM_DISABLE_CUDA_GRAPH`, `VLLM_NUM_SCHEDULER_STEPS`, `VLLM_MAX_NUM_BATCHED_TOKENS`). Save+Restart atomically patches both surfaces and rolls the NIM workload + rtvi-vlm Deployment. The two "advanced" sections (Inference engine, Speculative decoding) are collapsed by default — operator-facing explanations + recommended configs live in [`../docs/vss-performance-tuning.md`](../docs/vss-performance-tuning.md). |
| `/demo-data` | Synthetic VLM producer controls (replicas / tick rate / match probability) for demoing alerts without live RTSP. |
| `/profiles` | Operator-defined "scenes" — saved prompt + scenario + tuning bundles. |
| `/secrets` | View-only status of cluster secrets (rotation hints, lengths, never values). |
| `/logs` | Pod log tail across namespaces (rtvi, vst, alerts, agent). |
| `/diagnostics` | Cluster-wide health probes (kubectl version, namespace status, pod restart counts, recent events). |
| `/settings` | Auth, NextAuth secret rotation, app version. |

## Cluster references — single source of truth

[`src/lib/cluster-refs.ts`](src/lib/cluster-refs.ts) is the **canonical** lookup for every K8s service name, ConfigMap name, Deployment name, env-var key, and topic name the console addresses. Every value reads from `process.env` first so operators can override via [`k8s/console/11-configmap-env.yaml`](../k8s/console/11-configmap-env.yaml) at deploy time without rebuilding the image. Defaults target the VSS Helm-chart layout — the `vss-<profile>` namespace (default `vss-base`, via `VSS_NAMESPACE`) and the chart's service names (`vss-vios-sensor`, `vss-vios-streamprocessing`, `vss-rtvi-vlm`, `vss-agent`, …); set `CONSOLE_LEGACY_NAMESPACES=1` to address the pre-Helm raw-manifest namespaces (`vst`/`rtvi`/`nvidia-vss-single-gpu`/`alerts`) on fixture instances. RBAC for the default namespace is in [`../k8s/console/01-rbac.yaml`](../k8s/console/01-rbac.yaml).

Architecture note that drove the design: all RTVI / VST / alerts / demo-data pods run `hostNetwork: true` on a single MetalK8s node. Service DNS works for the console (which does **not** use hostNetwork), but the pods address each other via the bare node IP (10.42.1.111). The console always uses ClusterIP / headless-service DNS — the values in `cluster-refs.ts` reflect that, not the in-cluster bare-IP shortcuts.

The exported `CLUSTER` object covers: kafka brokers + topic names, redis URL, VST endpoints (sensor list / sensor add / proxy stream add / `sensorBase` + `storageBase` for clip download), mediamtx API, prometheus, grafana (url + user + password + login hint), alert-worker, RTVI ConfigMap keys, NIM preview endpoint, scenarios CM, alerts tuning CM, cameras CM + register-job prefix, demo-data deployment, S3 bucket + endpoint, restartable component map.

**Incident clip playback.** `/api/clips/[sensor]/[ts]` (and the `/preload` warmer) serve an HLS clip per incident. Incidents carry the sensor *name*, but the VST clip-download API is keyed by stream id — so the route resolves name → active stream id via `sensor/list` (preferring the `online` sensor with a recorded timeline), downloads the ±5s MP4 from `GET /storage/file/{streamId}?startTime&endTime&container=mp4` on the VST storage base (`vss-vios-ingress:30888/vst/api/v1`; override `VST_STORAGE_URL`), then transcodes MP4→HLS onto the PVC cache. Shared helpers: [`src/lib/streams/vst-clip.ts`](src/lib/streams/vst-clip.ts). A window at a still-recording timeline edge can 404 until that segment finalizes; older incidents always play.

**Camera recording + the Restart action.** A camera records only after **both** VST registration steps run — `sensor/add` (with a required `username`; empty string valid) **then** `proxy/stream/add` (`vstStartStream`). A sensor registered with only step 1 comes up `online` but never records, and the `REC` badge (`isTimelinePresent`) can read stale-true while nothing is being written — so "is it recording" is only truthfully answered by a 200 from `GET /api/clips/<name>/<isoTs>`, not the badge. The `/cameras` **Restart** button ([`src/app/api/cameras/[id]/restart/route.ts`](src/app/api/cameras/[id]/restart/route.ts)) re-runs both steps, resolving the RTSP URL from the config store → GCS camera doc → live VST (never constructed from `CAMERA_SIM_HOST`), and deletes the old VST sensor by its UUID `sensorId`. The same two-step add lives in the reconcile adapter, so `/cameras` add / restore / reconcile all record. A streamprocessing rollout does **not** restore recording (it rebuilds proxies, not recorder pipelines). Camera management (add/delete/restart) treats the camera-sim control-plane as a best-effort side-effect, not a gate — a camera defined by its RTSP URL (real IP camera or sim stream) is handled identically.

`prometheus.url` defaults to **metalk8s-monitoring**'s `prometheus-operated` (not artesca-monitoring, whose Prometheus CR has `serviceMonitorSelector=null` and holds 0 GPU series — the DCGM ServiceMonitor is discovered by metalk8s-monitoring via the `metalk8s.scality.com/monitor: ""` label). `grafana.url` is derived per-instance from `OBJECTSTORE_ENDPOINT_IP` → `https://<ip>:8443/` (or explicit `GRAFANA_URL`); `grafana.password` comes from `GRAFANA_PASSWORD` (empty in-cluster; `dev-console.sh` auto-populates it laptop-side from the node's ARTESCA Keycloak admin secret). Grafana sits behind ARTESCA's `:8443` Keycloak SSO (realm `artesca`), so the login is the ARTESCA admin, **not** the Grafana local admin (its form is disabled).

## VSS 3.2 Helm compatibility

The Helm path is the default and targets the NVIDIA VSS 3.2 chart (internal version `3.2.0-26.05.5`; clone at `../refs/video-search-and-summarization` @ `dev-26.06.1-2`). Most object names match the chart as-deployed: namespace `vss-base` (via `VSS_NAMESPACE`), `vss-vios-{sensor,streamprocessing,ingress}`, `vss-rtvi-vlm`, `vss-agent`, broker `kafka-kafka` (Confluent Kafka KRaft), `redis`, the `VLM_SYSTEM_PROMPT` env on the VLM Deployment, and NIM tuning keys `NIM_KVCACHE_PERCENT` / `NIM_MAX_MODEL_LEN` / `NIM_MAX_NUM_SEQS`.

The deployed object set is **profile-dependent** — the chart is parameterized (conditional subcharts, model-slug placeholders, `useReleaseNamePrefix`). The `cluster-refs.ts` defaults are calibrated to the **`alerts` profile** (the Pyramid showroom profile, ns `vss-alerts`). **Validated 2026-06-13 against a live g7e `alerts` deploy** — the defaults are correct for alerts; the env-overrides cover the `base` profile, where the deployed objects differ. Match a different profile via [`k8s/console/11-configmap-env.yaml`](../k8s/console/11-configmap-env.yaml), no code change; confirm with `kubectl -n <vss-ns> get svc,deploy,cm` + `kafka-topics --list`.

| What | Default | `alerts` profile (validated 2026-06-13) | `base` profile | Env override |
| ---- | ------- | --------------------------------------- | -------------- | ------------ |
| RTVI embed | `vss-rtvi-vlm` (collapsed) | ✅ correct — **no `vss-rtvi-embed`** (embed subchart disabled in alerts) | `vss-rtvi-embed` is a distinct Cosmos Embed1 Deployment/Service:8000 | `RTVI_EMBED_DEPLOYMENT` |
| VLM-tuning NIM + CM | NIM `nvidia-nemotron-nano-9b-v2`, CM `…-nim-env` | ✅ correct — only the nemotron NIM is deployed; no separate cosmos NIM | base deploys the `nvidia-cosmos-reason2-8b` VLM NIM (+ `…-nim-env`) | `NIM_TUNING_DEPLOYMENT`, `NIM_TUNING_CONFIG_MAP` |
| Kafka topics | `mdx-vlm`, `mdx-vlm-incidents`, `vision-llm-errors`, `vision-embed-messages`, `vision-embed-errors`, … | `mdx-vlm` / `mdx-vlm-incidents` / `vision-llm-errors` ✅ exist; `vision-embed-{messages,errors}` ❌ absent (no embed pipeline in alerts → dead but harmless subscriptions) | embed topics exist when the embed subchart is on | `KAFKA_TOPIC_*` |
| `NIM_MODEL_PROFILE` | free-text, empty = auto-detect (recommended) ([RtviTuningForm.tsx](src/components/tuning/RtviTuningForm.tsx)). The VLM picks the profile for the detected GPU; pin a hash only from the running NIM's `list-model-profiles` for the actual GPU — hashes are model/NIM-version/GPU-specific and a foreign-GPU hash fails with "no compatible profile". | same | same | — |
| NIM preview endpoint | `nvila-lite-preview.<ns>:8000` | `nvila` absent — repoint at `vss-rtvi-vlm` / the deployed NIM | same | `NIM_PREVIEW_ENDPOINT` |

`CONSOLE_LEGACY_NAMESPACES=1` switches the whole layout back to the pre-Helm per-namespace scheme (`vst`/`rtvi`/`agent`/`alerts`) for fixture instances.

## Data-fetching pattern

Server components import collectors from [`src/lib/overview-collector.ts`](src/lib/overview-collector.ts) directly — **no server-to-self HTTP, no Zod re-parse**. `collectOverviewSnapshot()` and `collectPodSummaries()` always resolve with a degraded snapshot + `warnings[]` rather than throwing, so a single broken probe doesn't take down the page.

The `/api/status/overview` and `/api/pods` routes are thin auth + JSON wrappers around the same collectors, used **only** by client components (`OverviewAutoRefresh`, the tuning page) where the HTTP + Zod boundary is appropriate.

This means: when adding a new server-rendered page, import the collector function directly. When adding a client component that needs live updates, hit the API route.

Routes for `/cameras`, `/prompt`, and `/scenarios` branch on `CONSOLE_RUNTIME`: the k8s path reads/writes Firestore (`instances/<instance>/{cameras,prompt,scenarios}` in GCP project `isv-alliances`) via `makeReconcileContext()` + write-through `reconcile-core`; the docker path uses the legacy GCS/ConfigMap path.

## Persistence layers

| What | k8s path | docker path |
| ---- | --------- | ----------- |
| Sessions, profiles, audit log | SQLite on PVC `console-data` (5 Gi) | SQLite on PVC `console-data` (5 Gi) |
| Camera registrations | Firestore `instances/<instance>/cameras` (GCP project `isv-alliances`); reconcile loop converges the in-cluster `register-cameras` Job from Firestore. | ConfigMap `cameras` in ns `pyramid-ingress` + GCS canonical `cameras/<vss-instance>.json`; `camera-restore-watcher` keeps them in sync. |
| VLM system prompt | Firestore `instances/<instance>/prompt` (GCP project `isv-alliances`); reconcile loop converges ConfigMap `rtvi-runtime-env`. | ConfigMap `rtvi-runtime-env` (key `RTVI_VLM_SYSTEM_PROMPT`) + GCS canonical `prompt/<vss-instance>.json`. |
| Alert scenarios | Firestore `instances/<instance>/scenarios` (GCP project `isv-alliances`); reconcile loop converges ConfigMap `scenarios`. | ConfigMap `scenarios` (key `scenarios.yaml`) + GCS canonical `scenarios/<vss-instance>.json`. |
| Per-camera overrides (`scenarioIds`, `recording`) | Firestore camera doc fields. | SQLite `camera_overrides` table on PVC `console-data`. |
| K8s secrets | `console-auth`, `console-aws`, `console-ssh` (3 required before first apply) | `console-auth`, `console-aws`, `console-ssh` (3 required before first apply) |

On the docker path, `bootstrap-compose-console.sh` auto-restores cameras + prompt + scenarios from GCS on every restart. Manual restore: `scripts/sync-cameras.sh --restore`, `scripts/sync-prompt.sh --restore`, `scripts/sync-scenarios.sh --restore` (each takes `--instance <name> --nvidia-vss-host <ip>`).

## Build pipeline

Image build happens **laptop-side** ([`../scripts/build-console-image.sh`](../scripts/build-console-image.sh)) using a Docker-compatible daemon (OrbStack on this laptop; Docker Desktop also supported). Persistent buildx layer cache at `${TMPDIR:-/tmp}/nvidia-vss-console-buildx-cache` (outside the repo; bust with `rm -rf`). Override via `BUILDX_CACHE_DIR`. Warm rebuilds drop from ~30s to under 10s when source is unchanged.

The host-ctr import flow on Rocky 8 nodes is fragile (libdl.so.2-class glibc 2.28 mismatches with importer containers). Catch breakages locally with [`../scripts/verify-ctr-compat.sh`](../scripts/verify-ctr-compat.sh) — spins up (or reuses) a Rocky 8 amd64 VM `nvidia-vss-ctr-lab`, installs containerd, and reproduces the bind-mount flow with a tiny amd64 tarball. First provision ~35s; reruns ~6s. Override `IMPORTER_IMAGE=...`; `alpine:3.19` is a reliable failure canary.

## Smoke testing

[`../scripts/smoke-test-console.sh`](../scripts/smoke-test-console.sh) applies [`k8s/console/`](../k8s/console/) against OrbStack's built-in K8s (`context: orbstack`) with the image swapped to `nginxinc/nginx-unprivileged:alpine`, probes removed, PVC rebound to `local-path`, and dummy Secrets created in-script. Catches **manifest-level** bugs (missing ConfigMap/Secret refs, broken Service selectors, PVC stuck Pending, RBAC binding to non-existent ns, port-name collisions) in ~30s — vs the ~10 min remote rebuild+scp+apply cycle. Idempotent, cleans up via `kubectl delete ns`.

Caveat: this smoke test does **not** test app behavior. End-to-end testing still needs `deploy-console.sh` against the EC2 cluster.

## Deploy + validate

```bash
# Build laptop-side, scp, host-ctr import on the node, kubectl apply.
scripts/deploy-console.sh

# Smoke-validate: pod Ready + /api/health/self returns 200.
scripts/validate-console.sh
```

The flow is idempotent — reruns re-apply the manifests and pick up image-tag changes.

## Pointers

- Top-level platform: [`../CLAUDE.md`](../CLAUDE.md)
- Deployer (laptop-side pre-install UI): [`../deployer/CLAUDE.md`](../deployer/CLAUDE.md)
- Design rationale + per-page spec: [`../docs/console-design.md`](../docs/console-design.md)
- Manifests: [`../k8s/console/`](../k8s/console/)
- Cluster references: [`src/lib/cluster-refs.ts`](src/lib/cluster-refs.ts)
