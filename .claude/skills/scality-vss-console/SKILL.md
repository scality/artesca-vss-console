---
name: scality-vss-console
description: Drive the in-cluster Scality Demo Console (post-install operator UI on :8800) — register cameras, edit alert scenarios, swap the VLM prompt, restart components, view incidents, configure kiosk mode for the Pyramid showroom. Use when the user says "/scality-vss-console", "register camera", "edit scenario", "swap prompt", "restart rtvi-embed", "open console", "kiosk mode", or asks about the Demo Console post-deploy UI. Distinct from `scality-vss-deploy` (pre-install) — this skill assumes the cluster is up.
license: Apache-2.0
metadata:
  version: "1.0.0"
  scope: "scality-isv-labs"
  tags: "scality nvidia-vss console kubernetes operator"
---

# Scality VSS Demo Console

The Demo Console (`console/`) is an in-cluster Next.js 16 pod in namespace `console`, serving on port `:8800`. It covers 13 operator-facing pages for post-install cluster operations: incident timeline, camera registration, scenario tuning, VLM prompt, alerts cooldown, NIM tuning, demo data, profiles, secrets, logs, and diagnostics. Manifests at [`k8s/console/`](../../k8s/console/). Architecture and per-page spec: [`console/CLAUDE.md`](../../console/CLAUDE.md).

The console is distinct from the deployer (`:5002`, laptop-side, pre-install). Use this skill after `scripts/deploy-console.sh` has run successfully and the console pod is in `Running` state.

## When NOT to use this skill

- Pre-install provisioning or pipeline phases → `scality-vss-deploy`
- Stack-up-but-broken triage (pod CrashLoop, GPU Operator stuck, RTSP not recording) → `vss-troubleshoot`
- S3 endpoint configuration (adding registry entries, BYO objectstore) → `scality-artesca-s3`

## Pages

13 operator-facing pages. Full operator intent → page → API mapping: [`references/pages.md`](references/pages.md).

```
/             Overview KPIs
/topology     Namespace topology diagram
/incidents    Incident timeline (kiosk-mode capable)
/cameras      Camera registration
/scenarios    Alert scenario rules
/prompt       VLM system prompt
/tuning       Inference + VST knobs
/demo-data    Synthetic event injection
/profiles     Saved prompt+scenario+tuning bundles
/secrets      Cluster secret status (view-only)
/logs         Pod log tail
/diagnostics  Cluster-wide health probes
/settings     Auth + app config
```

## Authentication

Single password via K8s Secret `console-auth`. NextAuth session. Retrieve the password:

```bash
kubectl -n console get secret console-auth -o jsonpath='{.data.password}' | base64 -d
```

## Reach the console

**Direct via host port** — the console pod binds `hostPort: 8800` on the node, so `http://<node-public-ip>:8800` reaches it (requires SG inbound rule on `:8800`). The `Service/console` in the same manifest is `ClusterIP` only — there is no NodePort.

**Port-forward** — use when the SG isn't open:
```bash
kubectl -n console port-forward svc/console 8800:8800
# then open http://localhost:8800
```

**Laptop dev mode** — `console/` runs locally on `:5003` (see top-level `CLAUDE.md` port table), hits the in-cluster API via `NEXT_PUBLIC_CONSOLE_API_BASE`.

## Common operator actions

### Register a camera

Cameras page in the console UI is the primary path. Full procedure, GCS persistence, CLI fallback, and camera-sim pairing: [`references/camera-ops.md`](references/camera-ops.md).

### Edit alert scenarios

Scenarios page → pick a scenario → edit keywords, cooldown window, severity → Save. Changes write to ConfigMap `scenarios` in ns `alerts` and to the GCS canonical. Full procedure and CLI fallback: [`references/scenarios-and-prompt.md`](references/scenarios-and-prompt.md) §Scenarios.

### Swap the VLM prompt

Prompt page → edit → Save. Writes to ConfigMap `rtvi-runtime-env` (key `RTVI_VLM_SYSTEM_PROMPT`) and to the GCS canonical. Default prompt source: [`scripts/stacks/nvidia-vss/default-vlm-prompt.txt`](../../scripts/stacks/nvidia-vss/default-vlm-prompt.txt). Full procedure and CLI fallback: [`references/scenarios-and-prompt.md`](references/scenarios-and-prompt.md) §VLM prompt.

### Restart a component

Tuning page → component card → Restart button. Equivalent kubectl command:

```bash
kubectl rollout restart deploy/<name> -n <namespace>
```

Restartable components and their namespaces (from `console/src/lib/cluster-refs.ts`):

| Component | Namespace |
|---|---|
| `rtvi-vlm` | `rtvi` |
| `rtvi-embed` | `rtvi` |
| `nim-cosmos-reason2-8b` | `rtvi` |
| `vst` | `vst` |
| `vss-agent` | `agent` |
| `alert-worker` | `alerts` |

### View incidents

Incidents page hits the VA-MCP endpoint (`:9901`) via `console/src/lib/va-mcp.ts`. Toggle auto-refresh for live-tail. Kiosk mode (Pyramid showroom unattended display): [`references/kiosk-mode.md`](references/kiosk-mode.md).

### Pull pod logs

Logs page wraps `kubectl logs -n <ns> deploy/<name> --tail=N` behind auth. Same data available directly via kubectl when on the node.

## State persistence

Three data layers:

1. **GCS canonicals** — cameras (`gs://scality-isv-labs-config/cameras/<instance>.json`), scenarios (`scenarios/<instance>.json`), prompt (`prompt/<instance>.json`). Versioned objects; survive cluster teardown and re-install.
2. **K8s ConfigMaps** — `cameras` in ns `pyramid-ingress`, `scenarios` in ns `alerts`, `rtvi-runtime-env` in ns `rtvi`. Live cluster state; reset on namespace delete.
3. **SQLite on PVC `console-data`** (5 Gi, ns `console`) — sessions, profiles, audit log.

Manual restore (all three from GCS):
```bash
scripts/sync-cameras.sh --restore --instance <name> --vst-host <host>
scripts/sync-scenarios.sh --restore --instance <name> --nvidia-vss-host <host>
scripts/sync-prompt.sh --restore --instance <name> --nvidia-vss-host <host>
```

`bootstrap-compose-console.sh` auto-restores all three on every docker restart.

## Tools you have

- `kubectl -n console` — console pod, PVC, configmaps
- `kubectl -n rtvi` — NIM + rtvi-vlm + rtvi-embed
- `kubectl -n vst` — VST sensor-ms + streamprocessing-ms
- `kubectl -n alerts` — alert-worker + scenarios ConfigMap
- `kubectl -n agent` — vss-agent
- `kubectl -n pyramid-ingress` — cameras ConfigMap + register-cameras Job
- Deployer API at `:5002/api/instances/[name]/...` — action triggers (role actions, restart)
- GCS canonicals via `gcloud storage` (ADC against project `isv-alliances`)
- `scripts/sync-cameras.sh`, `scripts/sync-scenarios.sh`, `scripts/sync-prompt.sh` — CLI CRUD + restore
