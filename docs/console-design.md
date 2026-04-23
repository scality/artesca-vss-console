# Demo Console — design doc

Unified operator console for the ARTESCA+ VSS live-ingest stack. One web UI at
`:8800` on the ARTESCA node that (a) gives deep real-time visibility into
everything running across both servers (ARTESCA MetalK8s + camera-sim EC2)
and (b) covers every operator action that currently requires `kubectl` +
`kubectl cp` + `ssh` + `systemctl restart`.

Forcing function: the June 2026 Pyramid retailer showroom operator should be
able to run the demo from one browser tab, not four tabs plus a terminal.

## Goals

1. **Single pane of glass** — every service status, every live metric, every
   log stream, every Kafka topic, every GPU, every camera feed, every
   incident, visible in one app without tab-switching.
2. **Every config change is a form** — add a camera, edit a scenario, tweak
   the VLM prompt, restart a component — no YAML editing, no SSH.
3. **Demo-safe** — operations visibly gated (confirm dialogs on destruction,
   dry-run on configuration changes).
4. **No single point of failure for the demo itself** — the console can be
   stopped and the pipeline keeps running. Console failures never cascade.
5. **Cross-origin two-server awareness** — operations that touch both the
   ARTESCA cluster AND the camera-sim instance (e.g., add a camera) are
   atomic from the operator's perspective.

## Non-goals

- **Pre-install / AWS provisioning flow** — handled by [`web/`](../web/)
  (port `:5002`), a separate minimal Next.js dashboard that owns the
  pre-flight → EC2 → cloud-init probe → ARTESCA install → GPU Operator
  → VSS phase-ready pod counts view. The Demo Console is strictly
  post-install: it assumes the cluster is running and both servers
  reachable.
- **Stopping / starting EC2 instances** — the Scality menubar already
  does this (Start / Stop state-gated actions calling
  `scripts/auto-shutdown.sh` and `scripts/after-start.sh`). Duplicating
  in the console gains nothing.
- Multi-tenant / RBAC per user. One shared operator credential is enough for
  the demo.
- Mobile-first. The showroom has a laptop + projector; responsive to iPad
  breakpoint is sufficient.
- Logging aggregation / long-term observability. Grafana + Loki are a
  separate track; the console tails live logs but does not retain them.
- Replacing the existing UIs. The VSS agent chat UI (:3000) and alert
  dashboard (:9100) remain — the console embeds / links to them.

## Decisions (resolved open questions)

| # | Decision | Impact |
| --- | --- | --- |
| 1 | **Access**: Scality engineers (Stéphane, Andres, Rahul, …) from their laptops via SG-whitelisted NodePort. Cluster-internal HTTP. No public TLS in scope. | No cert-manager / ingress rewrite. SG allows `:8800` from a curated IP list (Scality office + VPN + per-engineer home IPs). |
| 2 | **Kiosk mode**: Required for the Pyramid showroom. `?mode=kiosk` query-param (persisted in cookie) hides `/cameras`, `/scenarios`, `/prompt`, `/logs`, `/diagnostics`, `/settings`. Only `/`, `/topology`, `/incidents` remain visible. | Kiosk is a Phase 0 feature, not deferred. Login page also has a "Kiosk mode" checkbox. |
| 3 | **Auth**: Single shared password in K8s Secret (`console-auth`). `next-auth@5` credentials provider. | No user model, no reset flow, no email. Rotation via `/settings` regenerates the Secret via K8s API. |
| 4 | **AWS launch/teardown**: Out of scope (owned by `web/:5002` and the menubar). | Removes one whole page set (provisioning, instance lifecycle) and simplifies RBAC to in-cluster only. |
| 5 | **EC2 stop/start**: Out of scope (menubar owns it). | — |
| 6 | **Incident drill-in playback**: Click an incident → play the source VST-recorded clip in-browser via HLS. Server-side fetches the clip from ARTESCA S3 (`vss-video` bucket) OR proxies VST's clip endpoint; if only MP4/TS is available, ffmpeg sidecar transcodes to HLS on demand. Browser uses `hls.js` for cross-browser playback. | Adds `/api/clips/:sensor/:ts` SSE + HLS endpoint; adds ~2 dev-days to Phase 6. |
| 7 | **Camera model**: One camera has **N feeds** (default 2, matching the Pyramid 2-lens camera rail; 4+ allowed). Each feed is a separate RTSP source registered into VST as its own sensor. Naming: sensor_id = `<camera-id>-<feed-id>` e.g. `checkout-1-a`, `checkout-1-b`. | Revised TypeScript data model (below). The alert worker's `sensor_filter` glob still works (`checkout-*` matches both `checkout-1-a` and `checkout-1-b`). |
| 8 | **Editing scope**: All eight surfaces editable. Cameras (add/edit/remove, with N feeds each), scenario rules (keywords, sensor_filter, severity, cooldown-per-scenario), VLM system prompt, alert-worker env (cooldown, Slack webhook), rtvi-vlm tuning (max_num_seqs, KV cache %, max_model_len), manual rollout-restarts, demo-data controls (on/off, tick rate, match probability), NIM model swap (cosmos-reason2 ↔ cosmos-reason1 ↔ future NVILA-Lite). Plus: **named demo profiles** (save/load the whole scenario+prompt+camera config), **mediamtx path management**, **secret rotation UI** (NGC key, NVIDIA API key, HuggingFace token, Slack webhook). | Biggest scope expansion. Adds one Profiles page + one Secrets page + inline model-swap control on Prompt page. |

## Architecture

```text
browser (showroom laptop or iPad on the SG-whitelisted network)
   │  HTTPS (:8800 on the ARTESCA node, SG-restricted)
   ▼
┌────────────────────────────────────────────────────────────────┐
│ Next.js 16 App Router (Node.js 24, in-cluster pod)             │
│ ┌── Server Components / API routes ─────────────────────────┐  │
│ │  • Kubernetes API (ServiceAccount) — pods, CMs, logs,     │  │
│ │    rollout restart                                        │  │
│ │  • Kafka consumer (kafkajs) — live vision-llm-* stream    │  │
│ │  • Redis (ioredis) — alert worker queue + counters        │  │
│ │  • S3 (@aws-sdk/client-s3) — ARTESCA bucket object stats  │  │
│ │  • SSH (ssh2) — camera-sim config updates + journal tail  │  │
│ │  • mediamtx HTTP API — camera-sim path status             │  │
│ │  • kubectl exec → nvidia-smi — GPU state                  │  │
│ └───────────────────────────────────────────────────────────┘  │
│ ┌── Client Components (React 19, Tailwind, shadcn/ui) ──────┐  │
│ │  • React Query 5 min staleTime, SSE for real-time         │  │
│ │  • Recharts for metric graphs                             │  │
│ │  • React Flow for interactive topology                    │  │
│ └───────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
        │                          │
        │ in-cluster URLs          │ SSH + HTTPS over public internet
        ▼                          ▼
┌──────────────────────────┐   ┌──────────────────────┐
│ ARTESCA MetalK8s         │   │ camera-sim EC2       │
│  ns: vst / rtvi / agent  │   │  mediamtx :9997 API  │
│      / alerts / demo-    │   │  systemd camera-sim  │
│      data / pyramid-     │   │  /opt/camera-sim/    │
│      ingress / console   │   │  (ssh for writes)    │
└──────────────────────────┘   └──────────────────────┘
```

## Tech stack

Complementary to expatfolio where it makes sense (Next.js / TypeScript /
Tailwind / React Query / Vitest / Playwright — operators and engineers
recognize the same patterns) and divergent where the use case demands it
(in-cluster data sources, no managed auth/DB/email, deploys as a K8s pod
not to Vercel).

### Shared with expatfolio (keeps our mental model stable)

| Library | Why |
| --- | --- |
| `next@16` (App Router, React 19) | Same framework; server components do the K8s/Kafka/SSH work, client components do the live UI |
| `typescript` strict | Same config |
| `tailwindcss@3` + `@tailwindcss/typography` | Same Tailwind; dark-theme class toggle like the alert dashboard |
| `@radix-ui/*` via `shadcn/ui` | Same primitives (Dialog, DropdownMenu, Tabs, Toast, Select, Switch) |
| `@tanstack/react-query` | Same client-cache / refetch pattern |
| `recharts` | Metric graphs — matches expatfolio's portfolio graphs stylistically |
| `lucide-react` | Icons |
| `zod` | Runtime schema validation for ConfigMap round-trips, same pattern as expatfolio form validation |
| `vitest` + `@playwright/test` | Same test harness |

### Specific to this use case (replaces expatfolio's SaaS pieces)

| Library | Replaces | Why |
| --- | --- | --- |
| `@kubernetes/client-node` | Supabase | Official K8s JS client; in-cluster `ServiceAccount` auth; stream-friendly |
| `kafkajs` | — | Live Kafka consumer for the incident + VLM message stream |
| `ioredis` | — | Alert-worker Redis (queue + counters + cooldown keys) |
| `ssh2` or `node-ssh` | — | Writes to `/opt/camera-sim/cameras.yaml` + `mediamtx.yml` + `systemctl restart` on the camera-sim instance |
| `@aws-sdk/client-s3` | — | Count `vss-video` objects, compute growth rate |
| `@xyflow/react` (React Flow) | Recharts alone | Interactive topology graph with live status on each node |
| `@monaco-editor/react` | Textareas | VLM prompt editor with YAML/Markdown syntax highlight + diff view |
| `eventsource-parser` + Next.js Route Handlers streaming | WebSockets | Server-Sent Events for logs + Kafka stream — simpler than WS, one-way, plays nicely with Next.js Route Handlers |
| `next-auth@5` credentials provider | Clerk | One shared password from a K8s `Secret`; internal tool on a SG-whitelisted network |

### Node runtime + build

- Node.js 24 LTS (same as expatfolio)
- `next build` with `output: "standalone"` for a ~150 MB runtime image
- Multi-stage Dockerfile (same pattern as `docker/alert-worker/`)
- GHCR publication via `.github/workflows/build-console.yml`
- Deploys as a K8s `Deployment` in namespace `console`

### Intentionally NOT included

- **Clerk / Supabase / Resend / Stripe / Sentry / OpenTelemetry / Langfuse** —
  no SaaS surface area; an internal console on a closed network doesn't
  need any of these.
- **Vercel deploy** — hosted inside the ARTESCA cluster so it has native
  access to all the in-cluster services without public exposure of Kafka /
  Redis / kubeconfig.
- **External SaaS DBs (Supabase, Neon, RDS)** — no external DB. The console
  persists its own operator-facing state in a local SQLite DB on a PVC
  (`k8s/console/12-pvc.yaml` → `/data/console-data.db`): VLM-prompt profiles,
  audit log, SG-whitelist entries, and secret-rotation timestamps (schema in
  [`console/src/lib/db.ts`](../console/src/lib/db.ts)). Pipeline state —
  pod/GPU/NIM/Kafka health, prompt + scenario config — still reads live
  from K8s ConfigMaps, Secrets, Pods, and Redis on each request; the SQLite
  DB only holds data the console itself owns.

## Pages

App Router routes under `src/app/`. Each is a Server Component by default;
client components marked `"use client"`.

Routes marked **[kiosk]** stay visible when `?mode=kiosk` is active; all
others are hidden in kiosk mode.

| Route | Kiosk | Purpose |
| --- | --- | --- |
| `/` | [kiosk] | **Overview** — big cards: pod counts per namespace (traffic light per pod), NIM warmup state + token/sec, Kafka lag per topic, GPU util per card, S3 object count + growth rate, camera-sim instance state |
| `/topology` | [kiosk] | Interactive **React Flow** diagram — nodes = services, edges = connections (RTSP, gRPC, Kafka, HTTP). Live-colored by health. Click a node for its detail panel. |
| `/incidents` | [kiosk] | Live feed (replaces the standalone alert dashboard for console users). Filter by scenario / sensor / severity / time-window. Click an incident → **play the source clip** (HLS via `hls.js`, server-side ffmpeg proxy from ARTESCA S3) + raw Kafka payload + thumbnail. |
| `/cameras` | — | Table of cameras, each with N feeds (default 2 per Pyramid rail). Per-camera actions: edit / remove / restart. Per-feed actions: swap `.ts` file / disable / re-register. "Add camera" dialog uploads one or more `.ts` files → SCP to camera-sim → patch ConfigMap + restart replay + re-run register Job. |
| `/scenarios` | — | Table of scenario rules (from `k8s/alerts/12-configmap-scenarios.yaml`). Inline edit per row: keywords (chips), sensor_filter (glob input with live match preview against current camera feeds), severity, channels, **per-scenario cooldown override**, enabled. Save issues `kubectl patch configmap` + rollout-restart of the alert-worker. |
| `/prompt` | — | **VLM prompt editor** (Monaco). Current prompt in one pane; diff vs proposed in the other. "Preview" button sends a test message to the NIM and shows the response. Inline **NIM model swap** selector (cosmos-reason2 ↔ cosmos-reason1) rewrites the rtvi-vlm + NIM ConfigMaps and rollout-restarts both Deployments. "Save + restart" writes the ConfigMap + rollout-restart of rtvi-vlm. |
| `/tuning` | — | Knobs for rtvi-vlm (`max_num_seqs`, `kv_cache_percent`, `max_model_len`), alert worker (global `cooldown_seconds`, Slack webhook), and **VST ingest** (`always_recording` / `event_recording` mode, `event_record_length_secs`, `default_gov_length`, `supported_video_codecs`, `storage_threshold_percentage`, `default_file_expiry_minutes`). Form edits → ConfigMap patches → rollout-restart the affected Deployment. VST form shows live observed bitrate + GoP per camera next to the inputs so the operator sees the impact of a change. |
| `/demo-data` | — | Toggle the synthetic demo-data producer (scale 0 ↔ 1). Tick rate + match probability sliders → `kubectl set env`. Quick "rehearsal mode" button that scales to 1 with high match probability for a 60 s burst. |
| `/profiles` | — | **Save / load named demo profiles** — a profile bundles scenarios + VLM prompt + cameras + rtvi tuning + alert tuning + NIM model into one object stored in a `console-profiles` ConfigMap. Use cases: "pyramid-jun-8" config snapshotted after rehearsal; "aarco-oct" variant; roll back to a known-good before a new demo. Load applies every component atomically. |
| `/secrets` | — | **Secret rotation UI** — NGC key, NVIDIA API key, HuggingFace token, Slack webhook, console auth password. Paste a new value, confirm, and the console patches the target K8s Secret + rolls the consuming Deployment. |
| `/logs` | — | Log streamer — pick a pod + container → live tail via SSE. Filter regex, pause/resume, download last N lines. Camera-sim `journalctl -fu camera-sim` available via an SSH tail. |
| `/diagnostics` | — | On-demand runs of `scripts/validate-manifests.sh`, smoke tests per phase, `kubectl get events -A`, `nvidia-smi`, `kubectl top`. **VST Storage panel**: live S3 PUT rate + bytes/sec to `vss-video`, local `vst-video` emptyDir fill % against its 500 GiB limit, segment size distribution (last 200 objects), recorder frame-drop counter, last 20 objects in the bucket with sensor_id / timestamp / size. Results rendered inline. |
| `/settings` | — | Console-level config: **Network access** sub-panel — CIDR allow-list for `:8800` with add/remove (writes to the EC2 SG via `console-aws` creds + audit log). Kiosk-mode toggle persistence, feature flags, SSH key rotation for camera-sim, inspect current ServiceAccount permissions. |
| `/about` | — | Build info (git SHA, Next.js / Node versions), links to all docs, list of underlying service URLs, cross-link to the pre-install [`web/`](../web/) dashboard at `:5002`. |

## API surface

All under `src/app/api/*`. JSON in + out except SSE streams.

### Read

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/status/overview` | Aggregated pod counts + NIM + GPU + Kafka lag + S3 |
| GET | `/api/pods?ns=<ns>` | Pods in a namespace with summary status |
| GET | `/api/pods/:ns/:name` | Single pod detail |
| GET | `/api/cameras` | Registered sensors (VST) + replay-side sources (camera-sim) unified |
| GET | `/api/scenarios` | Parsed `k8s/alerts/12-configmap-scenarios.yaml` |
| GET | `/api/prompt` | Current VLM system prompt |
| GET | `/api/incidents?limit=50` | Recent incidents (proxies alert-worker `/api/incidents/recent`) |
| GET | `/api/gpu` | `nvidia-smi` output parsed as JSON |
| GET | `/api/topology` | Nodes + edges for React Flow, with live health |
| GET | `/api/tuning/vst` | Current subset of `vst-config` ConfigMap (recording mode, GoP, codecs, storage thresholds, file expiry) + per-camera observed bitrate / GoP from `:30000/api/v1/sensor/list` |
| GET | `/api/storage/vst` | `vss-video` object count + bytes + recent-object listing (S3 `ListObjectsV2` limit=20 sorted by LastModified), local `vst-video` emptyDir fill % (`kubectl exec sensor-ms -- df`), segment-size histogram from last 200 S3 objects, frame-drop counter from `sensor-ms` Prometheus at `:8080/metrics` |

### Write

| Method | Path | Action |
| --- | --- | --- |
| POST | `/api/cameras` | Add camera — dual-write: SCP to camera-sim + patch `k8s/pyramid-ingress/11-configmap-cameras.yaml` + restart both sides |
| PATCH | `/api/cameras/:id` | Update a camera — same dual-write path |
| DELETE | `/api/cameras/:id` | Remove — dual-unwrite |
| PATCH | `/api/scenarios` | Patch the entire scenarios ConfigMap + rollout-restart alert-worker |
| PATCH | `/api/prompt` | Patch `RTVI_VLM_SYSTEM_PROMPT` in `k8s/rtvi/11-configmap-runtime-env.yaml` + rollout-restart rtvi-vlm |
| POST | `/api/restart/:component` | Rollout restart a Deployment or StatefulSet — whitelisted set |
| POST | `/api/prompt/preview` | Send a one-shot prompt to the NIM, return the VLM response (dry-run) |
| PATCH | `/api/tuning/vst` | Patch the `vst-config` ConfigMap (guarded subset only — recording mode, GoP, codecs, thresholds, expiry) + rollout-restart `sensor-ms` + `streamprocessing-ms`. Rejects changes that flip `cloud_storage_*` fields — those rotate through `/secrets`, not `/tuning`. |

### Live streams (SSE)

| Path | Stream |
| --- | --- |
| `/api/logs/:ns/:pod/:container` | `kubectl logs -f` via K8s client |
| `/api/kafka/:topic` | kafkajs consumer, only while the client is connected |
| `/api/camera-sim/journal` | `ssh` + `journalctl -fu camera-sim` |
| `/api/incidents/live` | Re-broadcasts the alert-worker's Kafka consumption |

## Data model

```ts
// src/lib/types.ts

export type Health = "ok" | "warn" | "fail" | "unknown";

export interface PodSummary {
  namespace: string;
  name: string;
  phase: "Pending" | "Running" | "Succeeded" | "Failed" | "Unknown";
  ready: boolean;
  restarts: number;
  age: string;        // "4h23m"
  node?: string;
  gpus?: number;
}

export interface Camera {
  id: string;              // "checkout-1"
  role: "checkout" | "aisle" | "dock" | "backroom" | "other";
  description?: string;
  feeds: Feed[];           // default 2 per Pyramid 2-lens rail; 1..N allowed
}

export interface Feed {
  id: string;              // "a" | "b" | "lens1" | "lens2" | ...
  sensorId: string;        // VST sensor_id, `${camera.id}-${feed.id}` by convention
  source: string;          // filename in /opt/camera-sim/data/
  rtspUrl: string;         // rtsp://<EIP>:8554/<sensorId>
  vstRegistered: boolean;
  replayReady: boolean;    // mediamtx reports path ready
  bitrateMbps?: number;
  fps?: number;
  codec?: "hevc" | "h264";
}

export interface DemoProfile {
  name: string;                      // "pyramid-jun-8" | "aarco-rehearsal" | ...
  savedAt: string;                   // ISO 8601
  savedBy: string;                   // operator login (for shared-password mode: "console-operator")
  scenarios: Scenario[];
  vlmPrompt: string;
  cameras: Camera[];
  rtviTuning: Partial<{ maxNumSeqs: number; kvCachePct: number; maxModelLen: number }>;
  alertTuning: Partial<{ cooldownSeconds: number; slackWebhookConfigured: boolean }>;
  nimModel: "cosmos-reason2-8b" | "cosmos-reason1-7b" | string;
}

export interface Scenario {
  id: string;
  name: string;
  description?: string;
  severity: "low" | "medium" | "high";
  channels: Array<"ui" | "slack">;
  sensorFilter: string;   // glob or comma-separated
  keywords: string[];
  enabled: boolean;
}

export interface Incident {
  ts: string;              // ISO 8601
  scenarioId: string;
  scenarioName: string;
  severity: Scenario["severity"];
  sensorId: string;
  topic: string;
  summary: string;
  raw: unknown;
}

export interface GpuState {
  index: number;
  name: string;           // "NVIDIA L4"
  memoryUsedMiB: number;
  memoryTotalMiB: number;
  utilGpu: number;        // 0-100
  utilMem: number;
  tempC: number;
  powerW: number;
  processes: Array<{ pid: number; name: string; memMiB: number }>;
}

export interface OverviewSnapshot {
  takenAt: string;
  namespaces: Record<string, { total: number; ready: number; failed: number }>;
  nim: { ready: boolean; warmupPct: number; queueDepth: number };
  gpus: GpuState[];
  kafka: Record<string, { topic: string; consumerLagMsgs: number }>;
  s3: { bucket: string; objectCount: number; bytesTotal: number; growth24h: number };
  cameraSim: { instanceState: "running" | "stopped" | "unreachable"; pathsReady: number; pathsTotal: number };
}

export interface SgWhitelistEntry {
  id: string;               // stable uuid for the row
  cidr: string;             // "203.0.113.0/29"
  label: string;            // "Head office"
  addedBy: string;          // operator login
  addedAt: string;          // ISO 8601
  port: 8800;               // future-proofing; today always 8800
}

export interface ModelCard {
  image: string;                  // nvcr.io/nim/...
  displayName: string;
  parameterCount: string;         // "8.0 B"
  precision: string;              // "BF16"
  minGpuMemoryGiB: number;
  warmupSeconds: number;
  l4Validated: boolean;
  strengths: string[];
  limitations: string[];
  scalityUseCase: string;
}
```

Every schema has a `zod` mirror in `src/lib/schemas.ts` — API routes validate
inbound and outbound against the same types.

## Real-time strategy

Preferred: **Server-Sent Events over Next.js Route Handlers**. Reasons:

- One-way server → client is enough for our streams (logs, Kafka, incidents);
  we don't need full-duplex.
- SSE plays nice with Next.js `Response` objects — no custom WebSocket server.
- Reconnection + event-id replay built into `EventSource`.
- Simpler TLS path under the in-cluster ingress.

One long-lived server-side component per stream:

- **Logs** — a per-connection Kubernetes watch on the pod's log stream.
- **Kafka** — one kafkajs consumer per topic, shared across connected
  clients; server buffers last N events so late-joining clients see recent
  history.
- **Incidents** — proxy the alert-worker's view (Redis list + cooldown
  state) as SSE.

Polling fallback (every 5 s) for clients where SSE is proxy-buffered.

## Auth

- `next-auth@5` credentials provider.
- Single `CONSOLE_PASSWORD` in a K8s Secret (generated at install, rotated
  via the `/settings` page which regenerates the Secret via the K8s API).
- Cookie session, 12-hour TTL, HttpOnly + Secure + SameSite=Strict.
- All API routes require a session except `/api/health/self`.
- No OIDC / no SSO for this iteration. Overkill for a demo console behind
  an SG whitelist.

## Deploy — `k8s/console/`

Same structure as other phases.

```text
k8s/console/
  00-namespace.yaml
  01-rbac.yaml                  ServiceAccount + ClusterRole + ClusterRoleBinding
  10-secrets.yaml.example       CONSOLE_PASSWORD + camera-sim SSH key + AWS creds
  11-configmap-env.yaml         non-secret config (K8s endpoints, namespaces to observe)
  20-console.yaml               Deployment + Service + hostPort :8800
  kustomization.yaml
  README.md
```

### RBAC

ClusterRole `console-reader` — cluster-scoped but read-only:

- `pods`, `pods/log`, `pods/exec`: get / list / watch
- `deployments`, `statefulsets`, `configmaps`, `services`, `events`: get / list / watch
- `nodes` + `nodes/metrics`: get / list (for GPU state)

Role `console-writer` in each of the 6 namespaces (`vst`, `rtvi`, `agent`,
`alerts`, `demo-data`, `pyramid-ingress`):

- `configmaps`: patch (for editing scenarios, cameras, prompt)
- `deployments`, `statefulsets`: patch (for rollout-restart)
- `jobs`: create, delete (for re-running register-cameras)
- `pods/exec`: create (for nvidia-smi)

### Build workflow

- `.github/workflows/build-console.yml` — builds on push to `main` touching
  `console/**` or the workflow, pushes
  `ghcr.io/scality/isv-nvidia-vss/console:sha-<short>` + `:latest`.
- SHA-pinned actions (checkout@v4, setup-node@v4, docker/setup-buildx-action@v3,
  docker/login-action@v3, docker/build-push-action@v6).
- Multi-stage Dockerfile: deps → build → runner. Final image runs as uid 1001.

## Build phases

Sequenced so each lands with a testable outcome.

| Phase | Deliverable | Exit criterion |
| --- | --- | --- |
| 0 | Next.js + TypeScript + Tailwind + shadcn/ui scaffold; Dockerfile; `k8s/console/` skeleton; RBAC; deploys and serves a static "hello" at `:8800` behind auth | Login works, page renders |
| 1 | Overview page reading pods + NIM + GPU | Non-zero data on the page from a real cluster |
| 2 | Cameras page (read-only table from VST + mediamtx) | Table matches `kubectl -n vst … /sensor/list` + `curl :9997/v1/paths/list` |
| 3 | Scenarios + VLM prompt **read** + client-side Monaco editor | Editor loads current prompt; zod-validated diff preview |
| 4 | Scenarios + VLM prompt **write** (ConfigMap patch + rollout) | Edit in UI → `kubectl get configmap` shows the change → alert worker picks it up |
| 5 | Cameras **write** (dual-write camera-sim + ConfigMap + register Job) | Add camera in UI → VST `/sensor/list` shows it within ~30 s |
| 6 | SSE for logs + Kafka + incidents | Live log tail in browser matches `kubectl logs -f` |
| 7 | Topology page (React Flow) | Health colors track actual state within 5 s |
| 8 | Diagnostics page + demo-data on/off toggle | Every `scripts/*-smoke-test.sh` runnable from the UI |
| 9 | Settings page (password rotation + feature flags) | Rotate password via UI, next login uses new |

Each phase ships its own commit + includes a Playwright E2E that smokes the
added surface.

## Failure modes and mitigations

| Failure | Mitigation |
| --- | --- |
| Console pod crashes | K8s restarts it; the pipeline is unaffected (console is read-mostly; writes are completed transactions) |
| K8s API 401 — ServiceAccount token expired | Re-read the token file every request (K8s `@kubernetes/client-node` default) |
| Kafka broker drops — console can't see live events | Banner on every real-time panel "disconnected — reconnecting…"; polling fallback on the overview |
| Camera-sim SSH key rejected | Error in the cameras write path with a clear "rotate the SSH key in /settings" action |
| Simultaneous edit by two operators | Optimistic concurrency via the ConfigMap resourceVersion — second edit gets a 409 with "reload and retry" |
| NIM not reachable for `/api/prompt/preview` | Grey out the preview button with a tooltip pointing at the overview warmup state |

## Implementation decisions (follow-up round)

Second round of operator decisions answered. All resolved.

| # | Decision | Impact |
| --- | --- | --- |
| A | **Concurrent operators: 1–3.** One Kafka consumer per connected client. | No shared-consumer fan-out. Simplest code path. |
| B | **Profiles storage: SQLite on a PVC.** Not ConfigMap. | Add PVC `console-data` (5 Gi). Use `better-sqlite3` (Node sync, fast startup). Schema: `profiles`, `audit_log`, `sg_whitelist`. Nightly backup to S3 via `kubectl exec sqlite3 .backup`. |
| C | **Clip playback: best-possible experience.** Pre-cache last 10 incident clips; hover-preload on incident row; instant play from cache, on-demand ffmpeg only on miss (~2 s). HLS.js in low-latency mode. Auto-seek to the VLM-flagged moment (e.g., "theft at T+8 s" jumps the player to 0:08). Keyboard shortcuts (space / ← / → / F). | Server-side clip cache + hover API. +0.5 day to Phase 6. |
| D | **NIM model swap: 30-min downtime OK, but UI must explain the trade-offs.** `/prompt` has model cards — each model (Cosmos Reason 2 8B / Cosmos Reason 1 7B / NVILA-Lite 2B) with a card showing size, warmup time, GPU memory, strengths, weaknesses, and a Scality-validated-on-L4 badge where applicable. | Adds an on-page model catalog. See "Model cards" section below. |
| E | **VLM prompt preview: dedicated replica NIM.** Not the live NIM; don't interfere with demo inference. | **Major GPU budget consequence** — the 4 L4s on `g6.12xlarge` are already spoken for (NIM=GPU0, rtvi-vlm=GPU1, rtvi-embed=GPU2, VST=GPU3). Solution: deploy the preview NIM with the blueprint's `-shared-gpu` profile sharing GPU 0 with the primary NIM. Use `cosmos-reason1-7b-shared-gpu` for preview (7B weights fit alongside main Cosmos 2 8B on a 24 GB L4). Preview results will differ slightly from live inference — that's acceptable for prompt-iteration. |
| F | **SG whitelist: flexible, managed from UI.** Seed with Stéphane's home IP + Head office (`203.0.113.0/29`); `/settings` → "Network access" lets the operator add/remove CIDRs on the fly. | Console needs AWS EC2 write permissions: `DescribeSecurityGroups`, `AuthorizeSecurityGroupIngress`, `RevokeSecurityGroupIngress`. Since no IAM instance profile is available on the ARTESCA node (SSO-role constraint), the console reads AWS creds from a `console-aws` K8s Secret. Rotation via `/secrets` page. Audit log entries on every change. |

### Model cards — the catalog shown on `/prompt`

Each model card shows:

| Field | Example (Cosmos Reason 2 8B) |
| --- | --- |
| Image | `nvcr.io/nim/nvidia/cosmos-reason2-8b:1.6.0` |
| Parameter count | 8.0 B |
| Precision | BF16 |
| Min GPU memory | 16 GB weights + 4 GB KV @ `NIM_KVCACHE_PERCENT=0.25` |
| Warmup time on L4 | ~28 min (first boot; cached ~3 min) |
| NVIDIA L4 validated | Yes (our KV=0.50 / max_model_len=8192 config) |
| Scality use case | Primary live VLM — retail scene understanding |
| Known limitations | No audio input; no French output without prompt hint |
| Swap action | "Make Primary" / "Make Preview" buttons on the card |

Models catalogued for the June showroom:

- `cosmos-reason2-8b` (current primary)
- `cosmos-reason1-7b` (smaller, faster warmup — good fallback)
- `NVILA-Lite-2B` (what Rahul used in Dec 2025 POC; ~1 min warmup; cheaper inference)
- `qwen3-vl-8b-instruct` (alternate 8B VLM, comparable quality) — blueprint ships a NIM for it

Cards rendered from a static JSON file versioned in the repo at
`web/app/data/model-catalog.json` so updates don't require a rebuild.

## Implementation decisions (round 3 — final)

All remaining implementation questions resolved.

| # | Decision | Impact |
| --- | --- | --- |
| G | **GPU metrics: DCGM exporter → Prometheus → Grafana.** Not `kubectl exec nvidia-smi`. | Adds a foundational observability layer (new `k8s/observability/` namespace). Console reads GPU metrics from Prometheus, gets history graphs for free. Same stack benefits future Kafka / pod-level metrics. +1 dev-day (new phase 10). |
| H | **Camera-sim SSH key rotation: 90-day nag banner.** `/settings` flashes red when the key is > 90 days old. | UI-only: timestamp stored alongside the key in `console-data` SQLite; banner component on `/settings` and `/secrets`. |
| I | **AWS creds rotation: 90-day nag banner.** Same pattern as (H). | Same UI-only change. |
| J | **Preview NIM model: NVILA-Lite-2B.** Not Cosmos 1 7B — 14 GB weights + 16 GB primary = 30 GB won't fit even on L40S if we also want real KV cache. NVILA-Lite 2B weights ≈ 4 GB, proven on L4 per Rahul Padigela's Dec 2025 POC. | Smaller + faster preview (~1 min warmup vs. 20+ for Cosmos 1). Preview output differs from live inference — that's a feature: if a prompt works on 2B, it's likely OK on 8B. First-line prompt iteration is cheap. |
| K | **Instance upgrade: `g6.12xlarge` → `g6e.12xlarge` (4× L40S 48 GB).** Removes the "L4 not in blueprint profile" risk flagged in every `k8s/rtvi/README.md` and gives every component memory headroom. | **+$4.60/h** ($110/day; $3,300/mo always-on). Drop-in upgrade: edit `INSTANCE_TYPE` default in `scripts/launch-stack.sh` + swap NIM `.env` to the blueprint's L40S profile (replaces our hand-tuned L4 guesses). |

### Instance-type upgrade — specifics

```diff
- INSTANCE_TYPE=g6.12xlarge    # 4× L4 24 GB, ~$5.89/h
+ INSTANCE_TYPE=g6e.12xlarge   # 4× L40S 48 GB, ~$10.49/h
```

Everything downstream stays the same — same VPC, same SG, same AMI
(ARTESCA runs on any Linux; the GPU driver is installed after launch
by `bootstrap-gpu.sh`), same MetalK8s topology, same S3 bucket, same
SSO profile.

NIM env changes to use the shipped L40S profile (no more hand-tuned
L4 guesswork):

```diff
-NIM_KVCACHE_PERCENT=0.50      # L4 hand-tune, unvalidated
-NIM_MAX_MODEL_LEN=8192        # dialled down for 24 GB
-NIM_MAX_NUM_SEQS=2
+# Use blueprint-shipped L40S profile: hw-L40S.env (NIM_KVCACHE_PERCENT=0.8,
+# NIM_MAX_MODEL_LEN=32768, NIM_MAX_NUM_SEQS=4)
+NIM_ENV_FILE=${MDX_SAMPLE_APPS_DIR}/nim/cosmos-reason2-8b/hw-L40S.env
```

### Updated GPU budget (L40S 48 GB)

| GPU | Workload | Memory used | Headroom |
| --- | --- | --- | --- |
| 0 | Primary Cosmos 2 8B NIM (L40S profile) + Preview NVILA-Lite 2B | ~22 GB | ~26 GB free |
| 1 | rtvi-vlm | ~8 GB | ~40 GB free |
| 2 | rtvi-embed | ~6 GB | ~42 GB free |
| 3 | VST sensor-ms + streamprocessing-ms | ~4 GB | ~44 GB free |

Huge headroom — room for future model upgrades (Cosmos 3? Qwen3 12B?)
without another instance-type change.

## Implementation decisions (round 4 — VST ingest exposure)

Gap surfaced during live-flow review: the full VST recording/segmentation/storage config surface in [`k8s/vst/11-configmap-vst-config.yaml`](../k8s/vst/11-configmap-vst-config.yaml) is not editable anywhere in the UI today. Only `/cameras` (CRUD + observed bitrate display) and read-only pod status + `kubectl logs` cover VST. Operators currently have to edit YAML and rollout-restart by hand to change recording mode, GoP, local cache thresholds, or the cloud storage target.

| # | Decision | Impact |
| --- | --- | --- |
| L | **Expose VST ingest config in `/tuning` + VST storage panel on `/diagnostics`.** Extends the existing ConfigMap-patch + rollout pattern (same as `RtviTuningForm` / `AlertsTuningForm`). | Adds `VstRecordingForm` component + `/api/tuning/vst` GET/PATCH routes + `VstStoragePanel` component + `/api/storage/vst` GET route. Reads from the existing `vst-config` ConfigMap and the `:30000/api/v1/sensor/list` live metrics endpoint. +1.5 dev-days (new phase 11). |

### What the VST Recording form edits

Fields are a **guarded subset** of `vst_config.json` — the ones an operator can reasonably change without breaking the pipeline. Secrets and endpoint fields stay in `/secrets`.

| Field | Path in `vst_config.json` | Control | Default |
| --- | --- | --- | --- |
| Recording mode | `data.always_recording` / `data.event_recording` | Radio (always / event-only / both) | `always_recording: true`, `event_recording: false` |
| Event clip length | `data.event_record_length_secs` | Slider 5–60 s (enabled only when event-mode) | 10 |
| Event pre-roll | `data.record_buffer_length_secs` | Slider 0–10 s | 2 |
| Keyframe interval (GoP) | `onvif.default_gov_length` | Number input (frames) | 60 |
| Codecs allowed | `data.supported_video_codecs` | Multi-select (h264, h265) | `["h264", "h265"]` |
| Local cache eviction threshold | `data.storage_threshold_percentage` | Slider 50–99 % | 95 |
| Cache monitor frequency | `data.storage_monitoring_frequency_secs` | Number 1–60 s | 2 |
| File retention | `data.default_file_expiry_minutes` | Number (minutes) | 10080 (7 d) |
| Aging policy | `data.enable_aging_policy` | Toggle | false |
| Recorder frame drop | `data.recorder_enable_frame_drop` | Toggle + warning when off | true |

### What the VST Storage panel shows

Read-only diagnostic surface on `/diagnostics`. All numbers update every 5 s via React Query.

| Widget | Source | Refresh |
| --- | --- | --- |
| S3 PUT rate (objects/s, MB/s) | Derived from `ListObjectsV2` on `vss-video` between two samples | 5 s |
| `vss-video` object count + total bytes | `ListObjectsV2` with pagination | 30 s |
| Local `vst-video` emptyDir fill % | `kubectl exec sensor-ms -- df /home/vst/vst_release/vst_video` | 10 s |
| Segment size histogram | Last 200 S3 objects, bucketed by size | 30 s |
| Segment duration (empirical) | Consecutive-object timestamp deltas per sensor | 30 s |
| Frame drop counter | `sensor-ms` Prometheus `:8080/metrics` (`recorder_frames_dropped_total`) | 5 s |
| Recent objects | Last 20 S3 objects with sensor_id / ts / size / age | 10 s |
| Storage ceiling alert | When `vst-video` fill > 90 % OR S3 PUT error-rate > 1 % | computed |

### Why not a standalone `/storage` page

Discoverability. Operators looking for "why aren't recordings landing?" check `/diagnostics` — putting the storage panel there means one place to debug ingest. Putting it behind a standalone `/storage` route buries it. The `/tuning` page already bundles three subsystems (rtvi, alerts, VST) on one route; that's the right shape for this console.

### Why not editable cloud storage fields in `/tuning`

`cloud_storage_endpoint`, `cloud_storage_bucket`, `cloud_storage_access_key`, `cloud_storage_secret_key`, `cloud_storage_region` flip the recording target to a different S3 system — a destructive operation that usually wants a coordinated bucket + IAM change on the ARTESCA side first. These rotate through `/secrets` with a confirm dialog and an audit log entry, not through a recording tuning form.

## Open questions

None remaining. All four rounds of decisions are documented above.
First live run is the only remaining validation surface.

## Estimated effort

| Phase | Effort | Content |
| --- | --- | --- |
| 0 | 1 day | Scaffold + RBAC + deploy + auth + kiosk-mode query-param + `console-data` PVC + SQLite bootstrap |
| 1 | 1 day | Overview page (pods, NIM, GPU, Kafka lag, S3, camera-sim state) |
| 2 | 1 day | Cameras read-only (with N-feeds model) |
| 3 | 1 day | Scenarios + VLM prompt read/write (with per-scenario cooldown) |
| 4 | 1 day | Cameras dual-write (SCP + ConfigMap + re-register) with N-feeds |
| 5 | 1.5 day | Tuning page (rtvi-vlm knobs + alert worker env) + NIM model swap + **preview NIM deploy** (NVILA-Lite-2B sharing GPU 0 with primary; model cards on /prompt) |
| 6 | 2.5 days | SSE streams (logs, Kafka, incidents) + **best-effort HLS playback** (pre-cache, hover preload, auto-seek, keyboard shortcuts) |
| 7 | 0.5 day | Topology (React Flow) |
| 8 | 0.5 day | Demo-data controls + Diagnostics |
| 9 | 1.5 day | Profiles (SQLite-backed save/load) + Secrets rotation (incl. AWS creds + **90-day nag banners**) + Settings (**SG whitelist CRUD**) |
| 10 | 1 day | **Observability sidecar** — DCGM exporter DaemonSet + Prometheus + Grafana in a new `k8s/observability/` namespace. Console reads GPU metrics from Prometheus. |
| 11 | 1.5 day | **VST ingest config + storage visibility** — `VstRecordingForm` on `/tuning` (guarded subset of `vst_config.json` — see round-4 decisions), `VstStoragePanel` on `/diagnostics` (S3 PUT rate, local cache fill, segment histogram, frame drops). `/api/tuning/vst` + `/api/storage/vst` routes. Playwright E2E: edit GoP in UI → ConfigMap mutates → sensor-ms rolls → new value visible on readback. |
| Total | **~14 dev-days** | — |

Kiosk mode is tested with every phase (every kiosk-flagged page must
render correctly with config tabs hidden). Playwright E2E covers both
normal and kiosk flows.

### GPU budget (post-upgrade to L40S 48 GB)

Superseded by the L40S upgrade — see "Updated GPU budget (L40S 48 GB)"
in the round-3 decisions block near the top of this doc. Short version:
every component has huge memory headroom; preview NIM runs NVILA-Lite 2B
alongside primary Cosmos 2 8B on GPU 0 without contention.

## Cross-refs

- [`docs/architecture.md`](architecture.md) — stack-level architecture the console surfaces
- [`docs/demo-runbook.md`](demo-runbook.md) — operator procedures the console replaces
- [`docs/troubleshooting.md`](troubleshooting.md) — failure modes the console should surface
- [`docs/camera-sim-setup.md`](camera-sim-setup.md) — the camera-sim side the console writes to
- [`k8s/alerts/13-configmap-worker-code.yaml`](../k8s/alerts/13-configmap-worker-code.yaml) — alert worker the console proxies
- [`CLAUDE.md`](../CLAUDE.md) — overall project rules
