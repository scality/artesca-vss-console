# Console — development context

The **console** is the in-cluster post-install operator UI for the ARTESCA+ VSS stack. Next.js 16, port **:8800**, runs as a K8s pod in namespace `console` (manifests at [`../k8s/console/`](../k8s/console/)). Distinct from [`../deployer/`](../deployer/) on :5002, which is laptop-side pre-install provisioning — the console assumes the cluster is up and running.

For the platform substrate, see the top-level [`CLAUDE.md`](../CLAUDE.md). Design rationale + page spec (the operator-facing intent of each page): [`../docs/console-design.md`](../docs/console-design.md).

## Page tree

13 pages, all server components by default; client components are scoped to interactive bits (forms, auto-refresh).

| Page | Purpose |
| ---- | ------- |
| `/` | Overview KPIs (cluster baseline, pod summaries, NIM health, recent incidents). Auto-refreshes every 5s via `OverviewAutoRefresh` (client) → `/api/status/overview`. |
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

The exported `CLUSTER` object covers: kafka brokers + topic names, redis URL, VST endpoints (sensor list / sensor add / proxy stream add), mediamtx API, prometheus, alert-worker, RTVI ConfigMap keys, NIM preview endpoint, scenarios CM, alerts tuning CM, cameras CM + register-job prefix, demo-data deployment, S3 bucket + endpoint, restartable component map.

## VSS 3.2 Helm compatibility

The Helm path is the default and targets the NVIDIA VSS 3.2 chart (internal version `3.2.0-26.05.5`; clone at `../refs/video-search-and-summarization` @ `dev-26.06.1-2`). Most object names match the chart as-deployed: namespace `vss-base` (via `VSS_NAMESPACE`), `vss-vios-{sensor,streamprocessing,ingress}`, `vss-rtvi-vlm`, `vss-agent`, broker `kafka-kafka` (Confluent Kafka KRaft), `redis`, the `VLM_SYSTEM_PROMPT` env on the VLM Deployment, and NIM tuning keys `NIM_KVCACHE_PERCENT` / `NIM_MAX_MODEL_LEN` / `NIM_MAX_NUM_SEQS`.

A handful of values depend on the actual 3.2 deploy, not just the chart — the chart is parameterized (model slugs are `<replace-with-…>` placeholders, the `vss-rtvi-embed` subchart is conditional, `useReleaseNamePrefix` toggles name prefixes). The current `cluster-refs.ts` defaults were calibrated against a live deploy (2026-05-11). **Every divergent value is now env-overridable**, so the operator matches the live cluster via [`k8s/console/11-configmap-env.yaml`](../k8s/console/11-configmap-env.yaml) with no code change. Confirm the live names against the real cluster first: `kubectl -n <vss-ns> get svc,deploy,cm` (see the checklist in the project history / ask).

| What | Default | What 3.2 actually deploys | Env override |
| ---- | ------- | ------------------------- | ------------ |
| RTVI embed deployment | `vss-rtvi-vlm` (collapsed) | `vss-rtvi-embed` IS a distinct Cosmos Embed1 Deployment/Service:8000 — but the subchart is **conditional** (`vss-rtvi-embed.enabled`); was observed absent on 2026-05-11 | `RTVI_EMBED_DEPLOYMENT` |
| VLM-tuning NIM + CM | NIM `nvidia-nemotron-nano-9b-v2` (the LLM), CM `nvidia-nemotron-nano-9b-v2-nim-env` | the 3.2 VLM is `nvidia-cosmos-reason2-8b` (chart `vlmName`, demo target per `docs/demo-readiness.md`); tune the VLM via `nvidia-cosmos-reason2-8b` + `…-nim-env` | `NIM_TUNING_DEPLOYMENT`, `NIM_TUNING_CONFIG_MAP` |
| Kafka topics | per-stream (`mdx-vlm`, `mdx-vlm-incidents`, `vision-llm-errors`, `vision-embed-messages`, `vision-embed-errors`, …) | `vision-llm-errors` **and** `vision-embed-errors` DO exist in 3.2; only `vision-embed-messages` does not (embeddings flow on `mdx-embed`) | `KAFKA_TOPIC_*` (one per stream) |
| `NIM_MODEL_PROFILE` | fixed `cosmos-reason2-8b`/L40S profile hashes ([RtviTuningForm.tsx:44](src/components/tuning/RtviTuningForm.tsx#L44)) | chart selects the profile via `gpuType`; the hashes are model- and NIM-version-specific | — |
| NIM preview endpoint | `nvila-lite-preview.<ns>:8000` | `nvila` is absent from the 3.2 chart; the 3.2 VLM is `nvidia-cosmos-reason2-8b` | `NIM_PREVIEW_ENDPOINT` |

`CONSOLE_LEGACY_NAMESPACES=1` switches the whole layout back to the pre-Helm per-namespace scheme (`vst`/`rtvi`/`agent`/`alerts`) for fixture instances.

## Data-fetching pattern

Server components import collectors from [`src/lib/overview-collector.ts`](src/lib/overview-collector.ts) directly — **no server-to-self HTTP, no Zod re-parse**. `collectOverviewSnapshot()` and `collectPodSummaries()` always resolve with a degraded snapshot + `warnings[]` rather than throwing, so a single broken probe doesn't take down the page.

The `/api/status/overview` and `/api/pods` routes are thin auth + JSON wrappers around the same collectors, used **only** by client components (`OverviewAutoRefresh`, the tuning page) where the HTTP + Zod boundary is appropriate.

This means: when adding a new server-rendered page, import the collector function directly. When adding a client component that needs live updates, hit the API route.

## Persistence layers

| What | Where | Why there |
| ---- | ----- | --------- |
| Sessions, profiles, audit log | SQLite on PVC `console-data` (5 Gi) | Lightweight, no separate DB pod needed; 5 Gi is multi-year of metadata. |
| Camera registrations | ConfigMap `cameras` in ns `pyramid-ingress` + GCS `cameras/<vss-instance>.json` | ConfigMap drives the in-cluster `register-cameras` Job; GCS is the cross-laptop / cross-deploy canonical. |
| VLM system prompt | ConfigMap `rtvi-runtime-env` (key `RTVI_VLM_SYSTEM_PROMPT`) + GCS `prompt/<vss-instance>.json` | ConfigMap drives the live VLM; GCS preserves prompts across re-installs. |
| Alert scenarios | ConfigMap `scenarios` (key `scenarios.yaml`) + GCS `scenarios/<vss-instance>.json` | Same shape as cameras/prompt — live cluster state mirrored to versioned GCS object. |
| K8s secrets | `console-auth`, `console-aws`, `console-ssh` (3 required before first apply) | Standard K8s secret store. |

`bootstrap-compose-console.sh` auto-restores cameras + prompt + scenarios from GCS on every docker restart. Manual restore: `scripts/sync-cameras.sh --restore`, `scripts/sync-prompt.sh --restore`, `scripts/sync-scenarios.sh --restore` (each takes `--instance <name> --nvidia-vss-host <ip>`).

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
