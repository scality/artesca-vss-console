# Console pages

13 operator-facing pages + 3 infrastructure routes (`(auth)`, `about`, `chat` — not operator-facing). All pages are server components by default; client components are scoped to interactive bits (forms, auto-refresh). Source: [`console/src/app/`](../../../console/src/app/), [`console/CLAUDE.md`](../../../console/CLAUDE.md).

## Operator intent → page

| Intent | Page | API / data source |
|---|---|---|
| See stack health at a glance | Overview (`/`) | `/api/status/overview` — thin auth wrapper around `collectOverviewSnapshot()` from [`console/src/lib/overview-collector.ts`](../../../console/src/lib/overview-collector.ts). Auto-refreshes every 5s via `OverviewAutoRefresh` (client component). |
| See namespace topology diagram | Topology (`/topology`) | `/api/pods` — wraps `collectPodSummaries()` from the same collector. |
| See live incidents, kiosk display | Incidents (`/incidents`) | VA-MCP endpoint (`:9901`) via `console/src/lib/va-mcp.ts`. Visible in kiosk mode — see [`references/kiosk-mode.md`](kiosk-mode.md). |
| Register or edit a camera | Cameras (`/cameras`) | `/api/cameras` — writes to ConfigMap `cameras` in ns `pyramid-ingress` + GCS canonical `cameras/<instance>.json`. |
| Edit alert scenario rules | Scenarios (`/scenarios`) | `/api/scenarios` — writes to ConfigMap `scenarios` in ns `alerts` + GCS canonical `scenarios/<instance>.json`. |
| Edit VLM system prompt | Prompt (`/prompt`) | `/api/prompt` — writes to ConfigMap `rtvi-runtime-env` key `RTVI_VLM_SYSTEM_PROMPT` + GCS canonical `prompt/<instance>.json`. |
| Tune inference or VST knobs, restart a component | Tuning (`/tuning`) | `/api/tuning/<component>` — patches ConfigMap keys (`max_num_seqs`, `kv_cache_percent`, `max_model_len`, `NIM_MODEL_PROFILE`) and/or Deployment env (`NIM_DISABLE_CUDA_GRAPH`, `VLLM_NUM_SCHEDULER_STEPS`, `VLLM_MAX_NUM_BATCHED_TOKENS`); Save+Restart rolls the affected workload. |
| Inject synthetic test events | Demo Data (`/demo-data`) | `/api/demo-data` — controls synthetic VLM producer replicas + tick rate + match probability. |
| Save or restore an operator scene | Profiles (`/profiles`) | `/api/profiles` — saved prompt + scenario + tuning bundles; stored in SQLite on PVC `console-data`. |
| Check secret rotation status | Secrets (`/secrets`) | `/api/secrets` — view-only; shows lengths + rotation hints, never values. |
| Tail pod logs | Logs (`/logs`) | `/api/logs` — wraps `kubectl logs -n <ns> deploy/<name> --tail=N` across namespaces rtvi, vst, alerts, agent. |
| Run cluster-wide health probes | Diagnostics (`/diagnostics`) | `/api/diagnostics` — kubectl version, namespace status, pod restart counts, recent events. |
| Manage auth, rotate NextAuth secret | Settings (`/settings`) | Local config; no external API. |

## Collector architecture

Server components import `collectOverviewSnapshot()` and `collectPodSummaries()` from [`console/src/lib/overview-collector.ts`](../../../console/src/lib/overview-collector.ts) directly — no server-to-self HTTP, no Zod re-parse. Both functions always resolve with a degraded snapshot + `warnings[]` rather than throwing, so a single broken probe does not take down the page. The `/api/status/overview` and `/api/pods` routes are thin auth + JSON wrappers used only by client components where the HTTP + Zod boundary is appropriate.

## Cluster references

[`console/src/lib/cluster-refs.ts`](../../../console/src/lib/cluster-refs.ts) is the canonical lookup for every K8s service name, ConfigMap name, Deployment name, env-var key, and topic name the console addresses. All values read from `process.env` first so operators can override via [`k8s/console/11-configmap-env.yaml`](../../../k8s/console/11-configmap-env.yaml) at deploy time without rebuilding the image.

## Kiosk visibility

Only the Incidents page is visible in `?mode=kiosk`. All other pages are hidden. See [`kiosk-mode.md`](kiosk-mode.md) for setup and showroom checklist.
