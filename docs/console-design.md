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

- Multi-tenant / RBAC per user. One shared operator credential is enough for
  the demo.
- Mobile-first. The showroom has a laptop + projector; responsive to iPad
  breakpoint is sufficient.
- Logging aggregation / long-term observability. Grafana + Loki are a
  separate track; the console tails live logs but does not retain them.
- Replacing the existing UIs. The VSS agent chat UI (:3000) and alert
  dashboard (:9100) remain — the console embeds / links to them.

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
- **pgSQL / any database** — stateless. All state lives in K8s ConfigMaps
  or in Redis; console rebuilds its view on every request.

## Pages

App Router routes under `src/app/`. Each is a Server Component by default;
client components marked `"use client"`.

| Route | Purpose |
| --- | --- |
| `/` | **Overview** — big cards: pod counts per namespace (traffic light per pod), NIM warmup state + token/sec, Kafka lag per topic, GPU util per card, S3 object count + growth rate, camera-sim instance state |
| `/topology` | Interactive **React Flow** diagram — nodes = services, edges = connections (RTSP, gRPC, Kafka, HTTP). Live-colored by health. Click a node for its detail panel. |
| `/cameras` | Table of active cameras (from VST API + camera-sim paths). Row actions: edit / remove / restart. "Add camera" dialog uploads `.ts` file → SCP to camera-sim → patch ConfigMap + restart replay + re-run register Job. |
| `/scenarios` | Table of scenario rules (from `k8s/alerts/12-configmap-scenarios.yaml`). Inline edit per row: keywords (chips), sensor_filter (glob input with live match preview), severity, channels, enabled. Save issues `kubectl patch configmap` + rollout-restart of the alert-worker. |
| `/prompt` | **VLM prompt editor** (Monaco). Current prompt in one pane; diff vs proposed in the other. "Preview" button sends a test message to the NIM and shows the response. "Save + restart" writes the ConfigMap + rollout-restart of rtvi-vlm. |
| `/incidents` | Live feed (replaces the standalone alert dashboard for console users). Filter by scenario / sensor / severity / time-window. Click an incident → drill into the source Kafka payload + source VST clip + thumbnail. |
| `/logs` | Log streamer — pick a pod + container → live tail via SSE. Filter regex, pause/resume, download last N lines. Camera-sim `journalctl -fu camera-sim` available via an SSH tail. |
| `/diagnostics` | On-demand runs of `scripts/validate-manifests.sh`, smoke tests per phase, `kubectl get events -A`, `nvidia-smi`, `kubectl top`. Results rendered inline. |
| `/settings` | Console-level config: auth password rotation, feature flags (hide /diagnostics for demo mode), SSH key rotation for camera-sim. |
| `/about` | Build info (git SHA, Next.js / Node versions), links to all docs, list of underlying service URLs. |

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
  id: string;              // sensor_id, e.g., "checkout-1"
  role: "checkout" | "aisle" | "dock" | "backroom" | "other";
  source: string;          // filename in /opt/camera-sim/data/
  descriptor?: string;
  rtspUrl: string;         // rtsp://<EIP>:8554/<id>
  vstRegistered: boolean;
  replayReady: boolean;    // mediamtx reports path ready
  bitrateMbps?: number;
  fps?: number;
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

## Open questions

1. **Where does the console serve TLS?** Options: cluster-internal only
   (HTTP over SG-whitelisted NodePort, fine for demo); ARTESCA's existing
   ingress with cert; standalone EIP on the ARTESCA node. Answer gates
   whether we need a cert-manager for `console.internal`.
2. **Do we need a "presentation mode"?** Full-screen kiosk dashboard for
   during the Pyramid showroom — just the overview + incident feed, no
   config UI, no logs. Could be a query-param flag on `/` (`?mode=kiosk`).
3. **Should we run `nvidia-smi` via `kubectl exec` or via DCGM?** Exec is
   zero additional infra; DCGM exporter is the future-correct path when
   Prometheus/Grafana land. Start with exec.
4. **Real-time streams — do we multiplex Kafka consumers?** One per topic
   per connected client is expensive; sharing a server-side consumer +
   fan-out to SSE clients is cheaper but adds state. Defer to Phase 6 —
   one-per-client is fine at 1–3 operators.
5. **Authentication for the camera-sim SSH** — ed25519 key in a Secret, or
   just SSM (not available on SSO role)? Start with ed25519; document
   rotation.

## Estimated effort

| Phase | Effort |
| --- | --- |
| 0 (scaffold + RBAC + deploy) | 1 day |
| 1–2 (read-only overview + cameras) | 1 day |
| 3–4 (scenarios + prompt read/write) | 1 day |
| 5 (cameras dual-write) | 0.5 day |
| 6 (SSE streams) | 1 day |
| 7 (topology) | 0.5 day |
| 8 (diagnostics) | 0.5 day |
| 9 (settings) | 0.5 day |
| Total | ~6 dev-days |

## Cross-refs

- [`docs/architecture.md`](architecture.md) — stack-level architecture the console surfaces
- [`docs/demo-runbook.md`](demo-runbook.md) — operator procedures the console replaces
- [`docs/troubleshooting.md`](troubleshooting.md) — failure modes the console should surface
- [`docs/camera-sim-setup.md`](camera-sim-setup.md) — the camera-sim side the console writes to
- [`k8s/alerts/13-configmap-worker-code.yaml`](../k8s/alerts/13-configmap-worker-code.yaml) — alert worker the console proxies
- [`CLAUDE.md`](../CLAUDE.md) — overall project rules
