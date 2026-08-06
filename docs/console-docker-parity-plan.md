# Console docker/k8s parity — implementation plan

Work is segmented into five independent agent workgroups (§1–§5) plus one
dependent workgroup (§6) that unlocks only after §1 is merged. Each section is
self-contained enough to be handed directly to an agent.

**Prerequisite reading for every agent**

- [console/src/lib/helpers/docker-sock.ts](../console/src/lib/helpers/docker-sock.ts)
  — the canonical docker-socket helper; `inspectContainer`, `execInContainer`,
  `dockerSock`, `listComposeContainers`, `dockerRecreateWithEnv` (defined inline
  in prompt/route.ts, should be extracted — see §1).
- [console/src/app/api/restart/[component]/route.ts](../console/src/app/api/restart/%5Bcomponent%5D/route.ts)
  — reference for the `DOCKER_SERVICE_NAMES` mapping and the docker-socket
  container-restart pattern.
- [console/src/app/api/prompt/route.ts](../console/src/app/api/prompt/route.ts)
  — reference for the `dockerInspectEnv` + `dockerRecreateWithEnv` pattern;
  the most complete example of a dual-runtime route today.
- [console/src/app/api/secrets/[key]/route.ts](../console/src/app/api/secrets/%5Bkey%5D/route.ts)
  — reference for the `DOCKER_MODE` branch style and file-based secret
  persistence pattern.
- [console/src/lib/cluster-refs.ts](../console/src/lib/cluster-refs.ts)
  — all service / ConfigMap / namespace constants; add docker equivalents here
  rather than scattering them in route files.

**Docker compose container names** (verified against
`refs/video-search-and-summarization/deployments/`):

| k8s Deployment / StatefulSet | compose container |
|---|---|
| `cosmos-reason2-8b` (StatefulSet, ns `rtvi`) | `cosmos-reason2-8b` |
| `rtvi-vlm` (Deployment, ns `rtvi`) | `rtvi-vlm` |
| `rtvi-embed` (Deployment, ns `rtvi`) | `rtvi-embed` |
| `sensor-ms` (Deployment, ns `vst`) | `sensor-ms-dev` |
| `streamprocessing-ms` (Deployment, ns `vst`) | `streamprocessing-ms-dev` |
| `alert-worker` (Deployment, ns `alerts`) | `vss-video-analytics-api-alerts` |
| `nvidia-vss-agent` (Deployment, ns `agent`) | `vss-agent` |

---

## §1 — Tuning routes (alerts, vst, rtvi)

**Files to modify**

- `console/src/app/api/tuning/alerts/route.ts`
- `console/src/app/api/tuning/vst/route.ts`
- `console/src/app/api/tuning/rtvi/route.ts`
- `console/src/lib/helpers/docker-sock.ts` *(extract shared helpers)*

**What k8s does today**

All three routes share the same pattern:

1. `GET` — read a ConfigMap (`readNamespacedConfigMap` or `readConfigMapKey`),
   return the parsed values.
2. `PATCH` — validate the body, apply mutations, write back via
   `patchConfigMapRawKey` / `patchConfigMapKey`, then `rolloutRestart` the
   consuming Deployment or StatefulSet.

**What docker mode should do**

ConfigMaps don't exist in docker mode. The right docker-mode equivalent depends
on the route:

### §1a — alerts tuning

k8s ConfigMap: `alerts-runtime-env` (ns `alerts`)  
Docker container: `vss-video-analytics-api-alerts`  
Env keys: `COOLDOWN_SECONDS` (integer), `SLACK_WEBHOOK_CONFIGURED` ("true"/"false")

- `GET` docker: call `inspectContainer("vss-video-analytics-api-alerts")`, read
  `COOLDOWN_SECONDS` and `SLACK_WEBHOOK_CONFIGURED` from `Config.Env`. Fall back
  to defaults if the container is not running.
- `PATCH` docker: call `dockerRecreateWithEnv("vss-video-analytics-api-alerts", { COOLDOWN_SECONDS: "…", SLACK_WEBHOOK_CONFIGURED: "…" })`.
  This is the same function used in `prompt/route.ts:121–213` — extract it from
  there into `docker-sock.ts` before use. Also persist the values to
  `CONSOLE_DATA_DIR/.docker-tuning/alerts.json` so GET can serve them even
  when the container is stopped.

### §1b — vst tuning

k8s ConfigMap: `vst-config` key `vst_config.json` (ns `vst`)  
Docker containers: `sensor-ms-dev`, `streamprocessing-ms-dev`

VST in compose reads its JSON config from a bind-mounted file, not from env
vars. The agent must:

1. Identify the mount path for the vst config JSON inside `sensor-ms-dev`
   (check `refs/video-search-and-summarization/deployments/vst/developer/vst/docker-compose.yaml`
   for `volumes:` entries referencing `vst_config.json`).
2. `GET` docker: `execInContainer("sensor-ms-dev", ["cat", "<config-path>"])`,
   parse the JSON, return the same fields as the k8s GET.
3. `PATCH` docker: read current JSON via exec, merge patches, write back via
   `execInContainer(…, ["sh", "-c", "cat > <config-path> <<'EOF'\n…\nEOF"])`,
   then restart both `sensor-ms-dev` and `streamprocessing-ms-dev` via
   `dockerSock("POST", "/containers/<id>/restart?t=10")`.
4. If the config file path cannot be determined from the compose file, fall back
   to persisting to `CONSOLE_DATA_DIR/.docker-tuning/vst.json` and returning a
   note that a container restart with the new config mount is required.

### §1c — rtvi tuning

k8s ConfigMap: `rtvi-runtime-env` (ns `rtvi`)  
Docker container: `cosmos-reason2-8b`  
Env keys: `NIM_MAX_NUM_SEQS`, `VLM_NIM_KVCACHE_PERCENT`, `NIM_MAX_MODEL_LEN`

- `GET` docker: `inspectContainer("cosmos-reason2-8b")`, read the three keys
  from `Config.Env`.
- `PATCH` docker: `dockerRecreateWithEnv("cosmos-reason2-8b", { … })`.
  The NIM container takes 5–10 min to come back up — include
  `{ ok: true, note: "NIM container recreating — expect 5–10 min downtime." }`
  in the response.

### §1 — shared extraction task

`dockerRecreateWithEnv` is currently private inside `prompt/route.ts:121–213`.
Before implementing §1a–c, extract it to `console/src/lib/helpers/docker-sock.ts`
as a named export. The function signature is:

```ts
export async function dockerRecreateWithEnv(
  name: string,
  envOverrides: Record<string, string>,
): Promise<{ id: string }>
```

Also add a `DOCKER_TUNING_DIR` constant (`CONSOLE_DATA_DIR/.docker-tuning`)
alongside `DOCKER_SECRETS_DIR` — used by all three routes for persistence.

**Acceptance criteria**

- Tuning page loads in docker mode without a 502.
- GET returns current values read from the running containers.
- PATCH applies the change (container env updated or config file written) and
  returns `{ ok: true }`.
- k8s path is unchanged (all existing tests still pass).

---

## §2 — Scenarios routes

**Files to modify**

- `console/src/app/api/scenarios/route.ts`
- `console/src/app/api/scenarios/sync-gcs/route.ts`

**What k8s does today**

- `GET /api/scenarios` — reads `scenarios.yaml` from ConfigMap `scenarios`
  (ns `alerts`) and merges with GCS canonical copy; returns merged list with
  per-scenario camera overrides from SQLite.
- `PUT /api/scenarios` — validates the new scenario list, writes back to the
  ConfigMap, writes to GCS, restarts `alert-worker`.
- `POST /api/scenarios/sync-gcs` — reads ConfigMap, pushes to GCS.

**What docker mode should do**

GCS is already the canonical source for scenarios. In docker mode, treat GCS as
the read/write backend, exactly as the prompt route treats GCS for the system
prompt.

- `GET` docker: fetch scenarios from GCS via `gcsScenariosGet(VSS_INSTANCE_NAME)`.
  If GCS fetch fails or returns null, fall back to
  `CONSOLE_DATA_DIR/.docker-tuning/scenarios.json`. Merge camera overrides from
  SQLite as the k8s path already does.
- `PUT` docker: validate, persist to `CONSOLE_DATA_DIR/.docker-tuning/scenarios.json`,
  push to GCS via `gcsScenariosPut`, then restart
  `vss-video-analytics-api-alerts` via docker socket.
- `POST /api/scenarios/sync-gcs` docker: read from
  `CONSOLE_DATA_DIR/.docker-tuning/scenarios.json`, push to GCS. No ConfigMap
  read needed.

Key imports already available:
- `gcsScenariosGet`, `gcsScenariosPut` from `@/lib/helpers/gcs-config`
- `scenarioToGcsConfig` from `@/lib/helpers/scenarios-apply`

**Acceptance criteria**

- Scenarios page loads in docker mode.
- Creating / editing a scenario persists to GCS and restarts alert-worker.
- `sync-gcs` works in docker mode without attempting a ConfigMap read.
- k8s path unchanged.

---

## §3 — Demo-data routes

**Files to modify**

- `console/src/app/api/demo-data/route.ts`
- `console/src/app/api/demo-data/rehearsal/route.ts`

**What k8s does today**

- `PATCH /api/demo-data` — scales `demo-producer` Deployment replicas (enable /
  disable) and/or patches `TICK_SECONDS` / `MATCH_PROBABILITY` env vars on the
  Deployment via `appsV1().patchNamespacedDeployment`.
- `POST /api/demo-data/rehearsal` — reads current `MATCH_PROBABILITY` and
  replica count, scales to 1 with `MATCH_PROBABILITY=0.95`, auto-restores after
  60 s.

**What docker mode should do**

The demo-producer is a synthetic VLM caption generator. In compose it runs as a
container (exact service name to be confirmed — search
`refs/video-search-and-summarization/deployments/developer-workflow/dev-profile-alerts/compose.yml`
for `TICK_SECONDS` or `MATCH_PROBABILITY` env vars to identify the container).
Most likely container name: `vss-video-analytics-api-alerts` or a separate
`demo-producer` service.

- `PATCH` docker (`enabled` toggle):
  - enable → `dockerSock("POST", "/containers/<demo-container>/start")`
  - disable → `dockerSock("POST", "/containers/<demo-container>/stop?t=10")`
- `PATCH` docker (`tickRate` / `matchProbability`): call
  `dockerRecreateWithEnv(<demo-container>, { TICK_SECONDS: "…", MATCH_PROBABILITY: "…" })`.
- `POST /rehearsal` docker: read current env via `inspectContainer`, recreate
  with `MATCH_PROBABILITY=0.95`, schedule restore with `setTimeout(60_000, …)`
  same as k8s path.

**Investigation step for the agent:** before implementing, run
`docker inspect <demo-container> | jq '.Config.Env'` on the Brev instance to
confirm the container name and env var keys, then update `DOCKER_SERVICE_NAMES`
in `restart/[component]/route.ts` and a new `DOCKER_DEMO_CONTAINER` constant in
`cluster-refs.ts`.

**Acceptance criteria**

- Demo Data page enable/disable toggle works in docker mode.
- Tick-rate and match-probability sliders apply without a manual compose restart.
- Rehearsal mode fires, auto-restores after 60 s.
- k8s path unchanged.

---

## §4 — Observability: pod detail + GPU metrics

**Files to modify**

- `console/src/app/api/pods/[ns]/[name]/route.ts`
- `console/src/app/api/gpu/route.ts`

### §4a — pod detail (`/api/pods/[ns]/[name]`)

**What k8s does today**

`GET` calls `coreV1().readNamespacedPod({ name, namespace })` and returns phase,
conditions, container states, node name, resource requests/limits, labels.

**What docker mode should do**

`GET` docker: call `inspectContainer(name)` — the pod `name` param maps
directly to the docker container name (same names as the compose containers).
Map the result to the same response shape:

```ts
{
  namespace: "docker",     // no namespace concept in docker
  name: inspect.Name.replace(/^\//, ""),
  phase: inspect.State.Running ? "Running" : inspect.State.Status,
  conditions: [],          // no equivalent
  containers: [{
    name: inspect.Name,
    ready: inspect.State.Running,
    restartCount: inspect.RestartCount ?? 0,
    image: inspect.Config.Image,
    state: { running: inspect.State.Running ? { startedAt: inspect.State.StartedAt } : undefined },
  }],
  initContainers: [],
  node: null,
  startTime: inspect.State.StartedAt,
  podIP: inspect.NetworkSettings?.IPAddress ?? null,
  labels: inspect.Config.Labels ?? {},
}
```

### §4b — GPU metrics (`/api/gpu`)

**What k8s does today**

`GET` queries five Prometheus DCGM metrics (`DCGM_FI_DEV_GPU_UTIL`,
`DCGM_FI_DEV_FB_USED`, `DCGM_FI_DEV_FB_TOTAL`, `DCGM_FI_DEV_GPU_TEMP`,
`DCGM_FI_DEV_POWER_USAGE`) and returns per-GPU structs.

**What docker mode should do**

`status/overview/route.ts` already has a working docker GPU path via
`runOneShotGpuContainer` which execs `nvidia-smi --query-gpu=… --format=csv`
inside an existing GPU-accessible container. Reuse that function verbatim.

Steps:
1. In `GET` docker, call `runOneShotGpuContainer(RTVI_VLM_CONTAINER, ["nvidia-smi", "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw", "--format=csv,noheader,nounits"])`.
2. Parse the CSV output into the same `GpuState[]` struct the k8s path returns.
   Fields: `index`, `name`, `utilizationPct`, `memUsedMiB`, `memTotalMiB`,
   `temperatureC`, `powerW`.
3. If `runOneShotGpuContainer` returns null (docker socket unavailable, no GPU),
   return `{ gpus: [], warnings: ["nvidia-smi unavailable in docker mode"] }`.

`RTVI_VLM_CONTAINER = "rtvi-vlm"` — confirmed in `restart/[component]/route.ts`.

**Acceptance criteria**

- Topology page pod-detail drawer opens in docker mode and shows container
  running state, image, restart count.
- GPU page renders GPU cards in docker mode using nvidia-smi data.
- k8s paths unchanged.

---

## §5 — Storage stats + Diagnostics

**Files to modify**

- `console/src/app/api/storage/vst/route.ts`
- `console/src/app/api/diagnostics/[test]/route.ts`

### §5a — VST storage stats (`/api/storage/vst`)

**What k8s does today**

`GET` calls `runInPod("vst", "app=sensor-ms", ["…"])` to exec a `du` command
inside the sensor-ms pod for local cache fill metrics, and Prometheus for frame
drop rates.

**What docker mode should do**

- Cache fill: `execInContainer("sensor-ms-dev", ["df", "-h", "/path/to/vst-cache"])`.
  The agent must confirm the VST cache mount path from `docker-compose.yaml`
  `volumes:` entries for `sensor-ms-dev`.
- Frame drops: Prometheus is not guaranteed to be running in docker mode. If
  `PROMETHEUS_URL` env is set and reachable, use the existing `promQuery` helper;
  otherwise return `frameDrop: null` with a warning. Do not hard-fail.
- Shape the docker response to match the k8s response schema so the client
  Storage page is unchanged.

### §5b — Diagnostics (`/api/diagnostics/[test]`)

**What k8s does today**

The route has four test types: `ssh` (run script on remote host), `ssh-nvidia-smi`,
`k8s-api-events` (`coreV1().listNamespacedEvent`), `k8s-api-nodes`
(`coreV1().listNode`).

**What docker mode should do**

- `ssh` and `ssh-nvidia-smi` tests are already runtime-agnostic (they SSH to the
  host). No change needed.
- `k8s-api-events` docker: return `{ output: "k8s events not available in docker mode", exitCode: 0 }`.
  Alternatively, if there is a meaningful docker equivalent (e.g. recent container
  log lines), surface it; otherwise stub cleanly.
- `k8s-api-nodes` docker: replace with a docker-native summary. Call
  `dockerSock("GET", "/info")` to retrieve daemon info (kernel, Docker version,
  total CPUs, total memory), format it as a human-readable string, return in the
  same `{ output, exitCode }` shape.

**Acceptance criteria**

- Storage page loads in docker mode and shows cache fill (or a clear unavailable
  message if the volume path cannot be determined).
- Diagnostics page runs ssh-based tests in docker mode; k8s-api-events returns a
  clean stub; k8s-api-nodes returns docker daemon info.
- k8s paths unchanged.

---

## §6 — Profile apply (depends on §1)

**Files to modify**

- `console/src/app/api/profiles/[name]/route.ts`

**Depends on:** §1 (all three tuning routes must be docker-capable first).

**What k8s does today**

`POST /api/profiles/[name]` calls the tuning routes internally (via `fetch`)
to apply a saved profile. Because those routes are k8s-only, the whole apply
flow fails in docker mode.

**What docker mode should do**

No structural change is needed here beyond §1 landing. The profile apply route
calls `fetch("/api/tuning/alerts")`, `fetch("/api/tuning/vst")`,
`fetch("/api/tuning/rtvi")` — once those routes handle docker mode, profile
apply inherits docker support automatically.

The only action for this workgroup is to:
1. Verify that after §1 merges, `POST /api/profiles/[name]` succeeds end-to-end
   in docker mode (integration test or manual verify on Brev).
2. If the route constructs the fetch URLs from hardcoded localhost, confirm they
   resolve correctly inside the console container (use relative paths or
   `AUTH_URL`).

**Acceptance criteria**

- Profiles page "Apply" button works in docker mode after §1 lands.
- No code changes should be required in this file if §1 is implemented cleanly.

---

## Dependency graph

```
§1 (tuning)  ──────────────────────────────► §6 (profiles apply)
§2 (scenarios)   ─────── independent
§3 (demo-data)   ─────── independent
§4 (observability) ───── independent
§5 (storage/diag) ────── independent
```

§1 is the highest-value workgroup (gates Tuning page and Profile apply).
§2, §3, §4, §5 can be dispatched in parallel once §1 is in progress.

## Known unknowns for agents to resolve

| Item | Where to look |
|------|--------------|
| VST config JSON mount path inside `sensor-ms-dev` | `refs/video-search-and-summarization/deployments/vst/developer/vst/docker-compose.yaml` `volumes:` |
| Demo-producer compose service name and env keys | `refs/video-search-and-summarization/deployments/developer-workflow/dev-profile-alerts/compose.yml` — grep for `TICK_SECONDS` or `MATCH_PROBABILITY` |
| VST local cache mount path for `df` in §5a | Same docker-compose.yaml, look for video cache volume mounts |
| Whether Prometheus runs in docker mode | Check if port 9090 is in the compose stack; if yes, `PROMETHEUS_URL` works; if no, frame-drop metrics should be stubbed |
