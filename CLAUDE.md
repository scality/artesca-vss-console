# Console — development context

The **console** is the in-cluster post-install operator UI for the ARTESCA+ VSS stack. Next.js 16, port **:8800**, runs as a K8s pod in namespace `console` (manifests at [`k8s/`](k8s/)). Distinct from [`isv-labs:deployer/`](isv-labs:deployer/) on :5002, which is laptop-side pre-install provisioning — the console assumes the cluster is up and running.

> **`isv-labs:` paths** point into Scality's internal lab repository, which holds the deployer, the VSS workload manifests and the lab tooling. The console was extracted from it and is deployed onto the stack it provisions.
>
> ⚠ **This file is public and that repository is not going to be.** So a path written that way is not a link and never will be — it is a note about where a Scality-internal piece lives, kept only where it explains why code here is shaped the way it is. Two rules follow: **do not add new ones**, and when a fact a reader needs happens to live over there, **write the fact down here** instead of pointing at it. Everything needed to build, run, deploy and validate the console is in this repository. (Separately, `isv-labs.cameras.v2` and friends are frozen config-schema identifiers, not paths — see [CONTRIBUTING.md](CONTRIBUTING.md#the-isv-labs-schema-strings).)

For the platform substrate, see the top-level [`CLAUDE.md`](isv-labs:CLAUDE.md). Design rationale + page spec (the operator-facing intent of each page): [`docs/console-design.md`](docs/console-design.md).

## Page tree

23 pages (22 in the nav plus `/cameras/bindings`), all server components by default; client components are scoped to interactive bits (forms, auto-refresh). The sidebar ([`Nav.tsx`](src/components/Nav.tsx)) groups them into four labeled sections — **Live** (Overview / Topology / Incidents / Cameras), **AI & Storage** (Search / Ask the Store / VSS Chat / Evidence / Storage / KV Cache), **Configure** (Scenarios / VLM Prompt / Tuning / Agent / Test Footage / Profiles), **System** (Secrets / Logs / Diagnostics / Sizing Studio / Settings / About); section headers are hidden in kiosk mode.

The pages: `/`, `/topology`, `/incidents`, `/chat`, `/search`, `/storage`, `/kvcache`, `/analytics`, `/evidence`, `/agent`, `/cameras`, `/cameras/bindings`, `/scenarios`, `/prompt`, `/tuning`, `/test-footage`, `/profiles`, `/secrets`, `/logs`, `/diagnostics`, `/sizing-studio`, `/settings`, `/about`.

What each one does, and the traps in a few of them: [`docs/pages.md`](docs/pages.md).

## Cluster references — single source of truth

[`src/lib/cluster-refs.ts`](src/lib/cluster-refs.ts) is the **canonical** lookup for every K8s service name, ConfigMap name, Deployment name, env-var key, and topic name the console addresses. Every value reads from `process.env` first so operators can override via [`k8s/console/11-configmap-env.yaml`](k8s/11-configmap-env.yaml) at deploy time without rebuilding the image. Defaults target the VSS Helm-chart layout — the `vss-<profile>` namespace (default `vss-base`, via `VSS_NAMESPACE`) and the chart's service names (`vss-vios-sensor`, `vss-vios-streamprocessing`, `vss-rtvi-vlm`, `vss-agent`, …); set `CONSOLE_LEGACY_NAMESPACES=1` to address the pre-Helm raw-manifest namespaces (`vst`/`rtvi`/`nvidia-vss-single-gpu`/`alerts`) on fixture instances. The `cameras` ConfigMap and the register-cameras Jobs live outside the release, in `CAMERAS_NAMESPACE` (default `pyramid-ingress`, the lab's name) — `CLUSTER.cameras.namespace`, `watchedNamespaces()` and the `/api/settings/rbac` summary all read it. RBAC is in [`k8s/01-rbac.yaml`](k8s/01-rbac.yaml) (read-only, cluster-wide) plus two per-namespace Roles the deployer generates from the resolved namespace list — `console-writer` for the config writes and `console-exec` for `pods/exec` in the VSS namespace only. [`k8s/02-workload-rbac.yaml.example`](k8s/02-workload-rbac.yaml.example) is the same content with the namespace left a placeholder, and is a **parallel implementation** of what `deploy-console.sh` emits inline: a verb in one and not the other means a hand deploy 403s where a scripted one succeeds.

⚠ **Auditing `pods/exec` needs `kubectl auth can-i create pods --subresource=exec`.** The `pods/exec` spelling silently answers about `pods` — measured on kubectl 1.33 against a role granting `get,create`, it reports `create` **denied** and `list` **allowed**, wrong both ways and indistinguishable from an authoritative answer. Reading the live rules and comparing (`kubectl get clusterrole console-reader -o json`) is what catches it. Nothing needs exec outside the VSS namespace: `df` on the VST cache, `pg_isready` + two `psql` counts, and `redis-cli ping`/`info`. GPU state comes from Prometheus, and the `/diagnostics` nvidia-smi test runs over SSH.

Architecture note that drove the design: all RTVI / VST / alerts / test-footage pods run `hostNetwork: true` on a single MetalK8s node. Service DNS works for the console (which does **not** use hostNetwork), but the pods address each other via the bare node IP (10.42.1.111). The console always uses ClusterIP / headless-service DNS — the values in `cluster-refs.ts` reflect that, not the in-cluster bare-IP shortcuts.

The exported `CLUSTER` object covers: kafka brokers + topic names, redis URL, VST endpoints (sensor list / sensor add / proxy stream add / `sensorBase` + `storageBase` for clip download / `mediaOrigin` — the origin the `/api/media` proxy forwards snapshot/clip paths onto), mediamtx API, prometheus, grafana (url + user + password + login hint), alert-worker, agent (chat base URL / `mediaHost` — the host:port prefix the agent stamps into snapshot/clip URLs, rewritten to `/api/media` / `configMap` + `configKey` — the ConfigMap + key backing the `/agent` editor), `mediaProxyEnabled` (gates the `/api/media` proxy and the chat media-URL rewrite), RTVI ConfigMap keys, NIM preview endpoint, scenarios CM, alerts tuning CM, cameras CM + register-job prefix, S3 bucket + endpoint, restartable component map.

**Incident clip playback.** `/api/clips/[sensor]/[ts]` (and the `/preload` warmer) serve an HLS clip per incident. Incidents carry the sensor *name*, but the VST clip-download API is keyed by stream id — so the route resolves name → active stream id via `sensor/list` (preferring the `online` sensor with a recorded timeline), downloads the ±5s MP4 from `GET /storage/file/{streamId}?startTime&endTime&container=mp4` on the VST storage base (`vss-vios-ingress:30888/vst/api/v1`; override `VST_STORAGE_URL`), then transcodes MP4→HLS onto the PVC cache. Shared helpers: [`src/lib/streams/vst-clip.ts`](src/lib/streams/vst-clip.ts). A window at a still-recording timeline edge can 404 until that segment finalizes; older incidents always play.

**Camera recording + the Restart action.** A camera records only after **both** VST registration steps run — `sensor/add` (with a required `username`, empty string valid; a camera's optional label maps to VST's `location` field — VST's `/sensor/add` has **no** `description` field and silently drops unknown keys, so [`vstAddSensor`](src/lib/helpers/vst.ts) sets `location`) **then** `proxy/stream/add` (`vstStartStream`). A sensor registered with only step 1 comes up `online` but never records, and the `REC` badge (`isTimelinePresent`) can read stale-true while nothing is being written — so "is it recording" is only truthfully answered by a 200 from `GET /api/clips/<name>/<isoTs>`, not the badge. The `/cameras` **Restart** button ([`src/app/api/cameras/[id]/restart/route.ts`](src/app/api/cameras/[id]/restart/route.ts)) re-runs both steps, resolving the RTSP URL from the config store → GCS camera doc → live VST (never constructed from `CAMERA_SIM_HOST`), and deletes the old VST sensor by its UUID `sensorId`. The same two-step add lives in the reconcile adapter, so `/cameras` add / restore / reconcile all record. A streamprocessing rollout does **not** restore recording (it rebuilds proxies, not recorder pipelines). Camera management (add/delete/restart) treats the camera-sim control-plane as a best-effort side-effect, not a gate — a camera defined by its RTSP URL (real IP camera or sim stream) is handled identically.

`prometheus.url` defaults to **metalk8s-monitoring**'s `prometheus-operated` (not artesca-monitoring, whose Prometheus CR has `serviceMonitorSelector=null` and holds 0 GPU series — the DCGM ServiceMonitor is discovered by metalk8s-monitoring via the `metalk8s.scality.com/monitor: ""` label). `grafana.url` is derived per-instance from `OBJECTSTORE_ENDPOINT_IP` → `https://<ip>:8443/` (or explicit `GRAFANA_URL`); `grafana.password` comes from `GRAFANA_PASSWORD` (empty in-cluster; `dev-console.sh` auto-populates it laptop-side from the node's ARTESCA Keycloak admin secret). Grafana sits behind ARTESCA's `:8443` Keycloak SSO (realm `artesca`), so the login is the ARTESCA admin, **not** the Grafana local admin (its form is disabled).


## AWS and Helm

⚠ **The console holds no AWS credentials** and must not acquire any — how it reaches what it needs, and the VSS 3.2 Helm compatibility rules: [`docs/aws-and-helm.md`](docs/aws-and-helm.md).

## Data-fetching pattern

Server components import collectors from [`src/lib/overview-collector.ts`](src/lib/overview-collector.ts) directly — **no server-to-self HTTP, no Zod re-parse**. `collectOverviewSnapshot()` and `collectPodSummaries()` always resolve with a degraded snapshot + `warnings[]` rather than throwing, so a single broken probe doesn't take down the page.

The `/api/status/overview` and `/api/pods` routes are thin auth + JSON wrappers around the same collectors, used **only** by client components (`OverviewAutoRefresh`, the tuning page) where the HTTP + Zod boundary is appropriate.

This means: when adding a new server-rendered page, import the collector function directly. When adding a client component that needs live updates, hit the API route.

**Live streams (SSE).** Long-lived pushes (`/api/incidents/live`, `/api/pipeline/live`, `/api/camera-sim/journal`, kafka tails) go through [`src/lib/streams/sse.ts`](src/lib/streams/sse.ts)`::createSseResponse`, which emits an initial `: connected` comment the instant the stream opens. Next.js does not send a streamed response until its body's first chunk, so without that byte `EventSource` fires `open` only when the first real datum (or the 15s heartbeat) arrives — leaving the client on "reconnecting" for up to ~15s. The helper also owns the 15s heartbeat and abort teardown. `/api/incidents/live` additionally *polls* the alert-bridge (`GET /api/v1/realtime/incidents`, every 4s, per-poll timeout so a slow bridge can't stall the open) and pushes newly-seen incidents — it does **not** consume Kafka; the first poll primes the seen-set without replaying the backlog (the page's initial `GET` already rendered it).

Routes for `/cameras`, `/prompt`, and `/scenarios` read/write the config store via `makeReconcileContext()` + write-through `reconcile-core`. Kubernetes is the only runtime: the `CONSOLE_RUNTIME=docker` path (docker-socket container recreation, GCS-backed camera restore, the compose topology and overview collectors) was removed — `docker-sock.ts`, `gcs-bootstrap.ts`, `camera-restore-watcher.ts` and `caption-bridge.ts` with it.

**Chat + media + agent-config routes.** `POST /api/chat` proxies to the vss-agent's OpenAI-compatible `/chat` (`VSS_AGENT_URL`, default derived from `VSS_NAMESPACE` on the k8s path) and rewrites the agent's browser-unreachable media host (`CLUSTER.agent.mediaHost`, e.g. `vss-agent:8000`) to the same-origin `/api/media` proxy so clip/snapshot links in the reply resolve in the browser — gated by `CLUSTER.mediaProxyEnabled` (env `VSS_MEDIA_PROXY_ENABLED`). `GET /api/media/[...path]` is that proxy: it streams VST clip/snapshot bytes from `CLUSTER.vst.mediaOrigin`, restricted to a `Content-Type` allowlist keyed off the file extension, always serving `nosniff` + a `sandbox` CSP + `inline` disposition, with a path-traversal guard plus a post-normalization origin/prefix re-check pinning it to the `/vst/storage/` webroot. `GET`/`PATCH /api/agent-config` backs the `/agent` page — `GET` reads the live prompt / `max_iterations` / LLM wiring **and the active provider (`llmModelType`)** plus a live `{LLM_BASE_URL}/v1/models` reachability probe (`api.anthropic.com` is probed with `x-api-key` + `anthropic-version`; OpenRouter and NIM take a plain `Bearer`); `PATCH` accepts `llmModelType` (`nim`|`openai`), patches the `vss-agent-config` ConfigMap and/or the `vss-agent` Deployment env (JSON-patch env replace; wires `OPENAI_API_KEY` from the `vss-agent-anthropic` secret and strips `openai_llm.temperature` when the target serves Claude) and rolls a restart. **Known caveat:** the health probe reads the agent key from the plaintext `NVIDIA_API_KEY`/`OPENAI_API_KEY` env, so on the Claude path (where `OPENAI_API_KEY` is a `secretKeyRef`) it can't read the key and the badge shows a false `✕ auth failed` even though chat works — resolve the secretKeyRef in the probe to fix.

**TTS routes (on-box voice).** `POST /api/tts` proxies the on-box NVIDIA **Magpie TTS NIM** (`CLUSTER.tts.url`, env `VSS_TTS_URL`, default `http://magpie-tts.<vss-ns>:9000`) — builds a multipart `POST /v1/audio/synthesize` (`language`/`text`/`voice`) and streams back the `audio/wav`; fail-soft 502/503 so the client falls back to the browser voice. `GET /api/tts/voices` probes availability + lists voices (`parseVoiceList` in [`tts-voices.ts`](src/lib/tts-voices.ts) normalizes Magpie's `{"<langs>":{voices:[…]}}` shape); returns `{available:false}` when the NIM is down so the selector omits the on-box option. The NIM itself is deployed by [`k8s/nvidia-vss/tts/00-magpie-tts.yaml`](isv-labs:k8s/nvidia-vss/tts/00-magpie-tts.yaml) (GPU time-slice, model-cache PVC, `ngc-secret` pull; builds TensorRT engines on first start — validated on the Blackwell GPU). A third, NVIDIA-**hosted** engine (build.nvidia.com, NVCF gRPC `grpc.nvcf.nvidia.com` function-id `877104f7-e885-42b9-8de8-f6e4c6303969` + Bearer nvapi) is a planned addition.

## Persistence layers

**The config store has two backends and the default is a YAML file** — one per instance at `$CONSOLE_DATA_DIR/config-store/<instance>.yaml`. Firestore is the other, selected with `CONSOLE_CONFIG_STORE=firestore`, and its SDK is an **optional install** (`WITH_FIRESTORE=1`, mirroring the telemetry SDK) because a default clone would otherwise pull 208 packages for code paths it never reaches. Full design, semantics and the migration procedure: [`docs/console-config-store.md`](docs/console-config-store.md).

Three things from it that bite:

- ⚠ **Unset is not the same as `file`.** With `FIRESTORE_PROJECT_ID` set and `CONSOLE_CONFIG_STORE` unset, the console infers `firestore` — deliberately, because `kubectl set image` does not touch the ConfigMap and every pre-existing lab's data is in Firestore. A flat default would bring that pod up on an empty file with no error.
- ⚠ **Two pods write the store**, always: the console (UI edits, plus one startup convergence pass whatever `CONSOLE_DISABLE_RECONCILE_LOOP` says) and the `reconcile-agent` (status on every tick). So `CONSOLE_DATA_DIR` must be a volume both mount, and the file backend takes a cross-process lock — an in-process mutex would not reach.
- ⚠ **`upsert` replaces the whole entity, never merges fields.** The camera PATCH route unbinds a `promptId` and clears a `scenarioIds` override by `delete`ing the key and upserting; a merge makes both silent no-ops, and `scenarioIds` additionally loses its tri-state (absent = `sensor_filter` glob, `[]` = suppress all). One contract suite runs against both backends for this reason.

| What | k8s path | docker path |
| ---- | --------- | ----------- |
| Sessions, profiles, audit log, incident reports (`incident_reports`) | SQLite on PVC `console-data` (5 Gi) | SQLite on PVC `console-data` (5 Gi) |
| Camera registrations | The config store (`cameras`); reconcile loop converges the in-cluster `register-cameras` Job from it. | ConfigMap `cameras` in ns `pyramid-ingress` + GCS canonical `cameras/<vss-instance>.json`; `camera-restore-watcher` keeps them in sync. |
| VLM system prompt | The config store (`promptSets` + `activePromptId`); reconcile loop converges ConfigMap `rtvi-runtime-env`. | ConfigMap `rtvi-runtime-env` (key `RTVI_VLM_SYSTEM_PROMPT`) + GCS canonical `prompt/<vss-instance>.json`. |
| Alert scenarios | The config store (`scenarios`); reconcile loop converges ConfigMap `scenarios`. | ConfigMap `scenarios` (key `scenarios.yaml`) + GCS canonical `scenarios/<vss-instance>.json`. |
| Per-camera overrides (`scenarioIds`, `recording`) | Fields on the config store's camera entry. | SQLite `camera_overrides` table on PVC `console-data`. |
| K8s secrets | `console-auth`, `console-ssh` (2 required before first apply) | `console-auth`, `console-ssh` (2 required before first apply) |

On the docker path, `bootstrap-compose-console.sh` auto-restores cameras + prompt + scenarios from GCS on every restart. Manual restore: `scripts/sync-cameras.sh --restore`, `scripts/sync-prompt.sh --restore`, `scripts/sync-scenarios.sh --restore` (each takes `--instance <name> --nvidia-vss-host <ip>`).


## Build, CI and deploy

The build pipeline, the E2E environment, who hears a red run, the smoke test and the deploy-and-validate step: [`docs/ci-and-deploy.md`](docs/ci-and-deploy.md). ⚠ The workflow cannot mail — this repo is absent from the `github-pool` WIF allowlist and has no Actions secrets — so a red or **unverified** `build-console` run is caught by a laptop LaunchAgent (`com.scality.console.ci-alert`) instead.

## Architecture sheets (ISV-ARCH-05, ISV-ARCH-06)

```bash
node scripts/diagrams/dump-model.mjs > model.json
node scripts/diagrams/build-console.mjs model.json ../isv-presentations/diagrams/sheets/vss-console.excalidraw

node --conditions=react-server scripts/diagrams/dump-flow.mjs > flow.json
node scripts/diagrams/build-flow.mjs flow.json ../isv-presentations/diagrams/sheets/vss-flow.excalidraw
```

**ISV-ARCH-06** follows one frame from the lens to the operator — the three paths it takes at once, the carrier at each boundary, and where each lands on ARTESCA. It **imports** [`cluster-refs.ts`](src/lib/cluster-refs.ts) rather than parsing it, since those values are computed from `process.env` with defaults and a regex would read the source of a name instead of the name. Two consequences: the dumper must run under `--conditions=react-server`, because `cluster-refs.ts` opens with `import "server-only"` whose default entry throws by design; and it emits an explicit allowlist rather than the `CLUSTER` object, which carries live credentials (`CLUSTER.grafana.password` among them) onto a sheet that gets published.

**ISV-ARCH-05** draws the operator surface.

Draws the operator surface: the 22 pages by what kiosk mode does to each, the config-store entities shared with the deployer, and what the 67 API routes reach. Everything on it is read from source at run time — pages from [`Nav.tsx`](src/components/Nav.tsx), kiosk state from [`lib/kiosk.ts`](src/lib/kiosk.ts), shared state from the `ConfigStore` contract, backend reach from a walk of each route's `@/lib` imports. The scene builder is shared with the other sheets and lives in `scality/isv-presentations` (clone it next to this repository); the generator stays here, because it can only read this repo's source from inside it.

⚠ **The import walk follows `await import()` as well as `from`.** The reconcile context is reached dynamically at all 16 of its call sites, so a static-only walk concludes that no route touches the config store — which is exactly backwards, since that path is how cameras, prompt and scenarios are written.

Two things the walk surfaces, both still open:

- **Four nav links break in kiosk mode.** `/search`, `/analytics`, `/evidence` and `/storage` are in neither `KIOSK_HIDDEN_ROUTES` nor `KIOSK_ALLOWED_ROUTES`. `Nav.tsx` filters only the hidden list so the links render; [`proxy.ts`](src/proxy.ts) serves only the allowed list so the paths redirect to `/`. A showroom visitor clicks and lands back on the overview. Whichever list they belong in, they belong in one.
- **Seven mutating routes outlive their own page.** `proxy.ts` states that "mutating API routes are already guarded by `rejectIfKiosk()` in each handler", and 17 of 33 are. The other 16 include seven under a page kiosk hides — `/api/cameras/[id]` (PUT/PATCH/DELETE), `/api/cameras/[id]/restart`, the three `sync-gcs` routes and `/api/diagnostics/[test]`. `/api/cameras/[id]` DELETE is the sharpest: the sibling collection route `/api/cameras` POST *does* guard, so the asymmetry is within one resource. `/api/settings/kiosk` is exempt by design and named as such in the dumper — it is the exit from kiosk mode, and guarding it would trap the session.

## Issue tracking — GitHub, not Jira

**Work on this repository is tracked in its own GitHub Issues.** This repository is
published under Apache-2.0 and read by people with no Scality account, so a tracker
they cannot open is not a tracker: an `ISVD-…` key tells an outside reader that a
decision exists and denies them every word of it.

Three consequences, and the third is the one that gets forgotten:

- **File here, not in ISVD.** A bug, a feature, a limitation of the published
  console — GitHub. What stays in ISVD is work that is *about* Scality's own
  deployment rather than about the console: lab migrations, showroom demos, the
  publication programme itself (ISVD-547 and its children).
- **`ISVD-…` keys already in the tree stay.** 33 of them across 26 files, plus 62
  commit footers. They record which change a line came from, and that is worth
  more than a tidy tree. [CONTRIBUTING.md](CONTRIBUTING.md) tells an outside reader
  what they are so they do not hunt for a dead link. New references use
  `Issue: #<number>`.
- **A Jira ticket that has a public counterpart says so, one way.** Put the GitHub
  URL in the ISVD ticket. Never the reverse, and never paste Jira content into a
  GitHub issue — internal tickets carry customer names, lab hostnames and
  credential-adjacent detail, and a public comment cannot be unpublished. This is
  also why no two-way sync connector is wired: the throughput it would buy on a
  repository with near-zero external issue volume does not pay for a leak that
  posts itself.

Security findings are the exception to all of it and go through the Security tab's
private advisory flow, never an issue — [SECURITY.md](SECURITY.md) states the
policy and the known limitations of a default deployment.

## Pointers

- Contributing + issue conventions: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Security policy: [`SECURITY.md`](SECURITY.md)
- Top-level platform: [`isv-labs:CLAUDE.md`](isv-labs:CLAUDE.md)
- Deployer (laptop-side pre-install UI): [`isv-labs:deployer/CLAUDE.md`](isv-labs:deployer/CLAUDE.md)
- Design rationale + per-page spec: [`docs/console-design.md`](docs/console-design.md)
- Manifests: [`k8s/`](k8s/)
- Cluster references: [`src/lib/cluster-refs.ts`](src/lib/cluster-refs.ts)
