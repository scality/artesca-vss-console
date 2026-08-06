# Agent prompt — Migrate the in-cluster Console UI to the upstream NVIDIA VSS Helm layout

Hand this entire file to a fresh agent (any IDE / CLI session). It's
self-contained: paths, namespace map, service-name map, file inventory,
test plan.

---

## Context

The isv-labs repo just switched its **K8s default deploy path** from
hand-authored manifests under `isv-labs:k8s/nvidia-vss/{vst,rtvi,agent,alerts}/` to
the upstream NVIDIA VSS **Helm chart** (chart `26.04.2` on the `develop`
branch, EA early June 2026 with COMPUTEX / GTC Taipei). The chart lives
upstream at:

```
https://github.com/NVIDIA-AI-Blueprints/video-search-and-summarization
@ commit 5857663 (pinned in config/upstream-vss.env)
path: deploy/helm/developer-profiles/dev-profile-{base,alerts,lvs,search}/
     deploy/helm/services/{infra,vios,agent,ui,alert,analytics,rtvi,nims,
                            video-summarization}/
```

The new bootstrap is `scripts/stacks/nvidia-vss/bootstrap-helm-deploy.sh`,
which runs `helm upgrade --install vss-<profile>` into namespace
`vss-<profile>` (one of `vss-base`, `vss-alerts`, `vss-lvs`, `vss-search`).

The hand-authored manifest tree and the four bootstraps that went with it no
longer exist in isv-labs. The active K8s path is Helm.

**Your job**: migrate the in-cluster operator console (this repository) to
work against the new namespace + service-name layout. The console
currently hardcodes the legacy layout in
`src/lib/cluster-refs.ts` and several API routes.

## What changes upstream → ours

### Namespace map

| Legacy (was) | Helm path (is)          |
|---|---|
| `vst`        | `vss-<profile>`        |
| `rtvi`       | `vss-<profile>`        |
| `nvidia-vss-single-gpu` (agent) | `vss-<profile>` |
| `alerts`     | `vss-<profile>`        |

Everything from VST through VSS agent through alert-bridge is now in a
**single namespace** (the Helm release namespace). Side-cars
`observability`, `pyramid-ingress`, `demo-data` keep their own
namespaces (operator-authored, applied alongside the Helm release).

### Service-name map (most important entries — verify exhaustively against
the rendered chart)

| Legacy service | Helm chart service          | Notes |
|---|---|---|
| `redpanda.rtvi`               | `redpanda.vss-<profile>` (subchart `infra/redpanda`) | Kafka topics likely renamed too |
| `redis.vst`                   | `redis.vss-<profile>` (subchart `infra/redis`) |  |
| `sensor-ms.vst`               | `vss-vios-sensor.vss-<profile>` |  |
| `streamprocessing-ms.vst`     | `vss-vios-streamprocessing.vss-<profile>` |  |
| `vst-ingress.vst`             | `vss-vios-ingress.vss-<profile>` | port still 30888 |
| `nim-cosmos-reason2.rtvi`     | `nvidia-cosmos-reason2-8b.vss-<profile>` | NIMService CRD now |
| `rtvi-vlm.rtvi`               | `vss-rtvi-vlm.vss-<profile>` |  |
| `rtvi-embed.rtvi`             | `vss-rtvi-embed.vss-<profile>` (verify — may be in nims/ subchart) |  |
| `nvidia-vss-agent.nvidia-vss-single-gpu` | `vss-agent.vss-<profile>` |  |
| `nvidia-vss-ui`               | `vss-agent-ui.vss-<profile>` |  |
| `nvidia-vss-va-mcp`           | `vios-mcp.vss-<profile>` (verify) |  |
| `alert-worker.alerts`         | `vss-alert-bridge.vss-<profile>` (different impl — Bridge, not our worker) |  |
| `prometheus-operated.artesca-monitoring` | unchanged (ARTESCA install) |  |

The agent subchart: `services/agent/`. UI: `services/ui/`. Ingress:
`vios-ingress` template (HAProxy path-rewrites if `vssIngress.enabled=true`,
otherwise NodePort).

### Concrete next steps

1. **Render the chart against a sample profile** to enumerate every
   Service / Deployment / ConfigMap / Secret name:
   ```bash
   git -C refs/video-search-and-summarization worktree add /tmp/vss-helm \
     5857663
   CHART=/tmp/vss-helm/deploy/helm/developer-profiles/dev-profile-alerts
   helm dependency build "$CHART"
   helm template smoke "$CHART" -n vss-alerts \
     -f "$CHART/values-realtime.yaml" \
     -f config/vss-helm-values/scality-overlay-base.yaml \
     -f config/vss-helm-values/scality-overlay-aws-s3.yaml \
     --set ngc.apiKey=fake --set global.externalHost=10.0.0.1 \
     --set vios.vss-vios-streamprocessing.cloudStorageEndpoint=https://s3.us-east-2.amazonaws.com \
     > /tmp/vss-rendered.yaml
   grep -E "^(kind|  name):" /tmp/vss-rendered.yaml > /tmp/vss-resources.txt
   ```
   Use `/tmp/vss-resources.txt` as ground truth for the service-name map.

2. **Refactor `src/lib/cluster-refs.ts`** so it reads
   `process.env.VSS_NAMESPACE` (default `vss-base`) and templates every
   service URL through it. Today the file hardcodes `redis.vst`,
   `sensor-ms.vst`, `redpanda.rtvi`, `alert-worker.alerts`, etc. Switch
   them to:
   ```ts
   const VSS_NS = process.env.VSS_NAMESPACE ?? "vss-base";
   const REDIS_URL = process.env.REDIS_URL ?? `redis://redis.${VSS_NS}.svc.cluster.local:6379`;
   // etc.
   ```
   Update every service-name to the upstream chart name (vss-vios-sensor,
   vss-rtvi-vlm, vss-agent, …) per the map above.

3. **Update `src/app/api/topology/route.ts`** — the topology graph
   has hardcoded `deploymentName` strings (rtvi-vlm, nim-cosmos-reason2,
   nvidia-vss-agent, …) that match the legacy layout. Re-author the
   nodes + edges against the rendered chart names. The file is the
   single biggest piece — expect to rewrite ~50 % of it.

4. **Update `src/app/api/secrets/[key]/route.ts`** —
   `objectstore-creds` still exists (we generate it at install time;
   bootstrap-helm-deploy.sh applies it) but lives in `vss-<profile>`
   not `vst`/`rtvi`/`agent`/`alerts` — every namespace fan-out goes
   away, replaced by a single namespace lookup.

5. **Update `src/components/settings/RbacInspector.tsx`** — the
   namespace list it inspects shrinks from 4 (vst/rtvi/agent/alerts) to
   1 (vss-<profile>) plus the side-cars (observability, pyramid-ingress,
   demo-data) that stay unchanged.

6. **Update `src/lib/helpers/prompt-apply.ts` + `tuning/rtvi`
   route + `prompt` route** — these patch ConfigMaps and restart
   Deployments by name. Both name and namespace change. Today:
   ```
   kubectl patch deploy/rtvi-vlm -n rtvi
   kubectl patch cm/rtvi-runtime-env -n rtvi
   ```
   Helm path:
   ```
   kubectl patch deploy/vss-rtvi-vlm -n vss-<profile>
   kubectl patch cm/vss-rtvi-vlm-runtime-env -n vss-<profile>
   ```
   Verify the rendered ConfigMap names against `/tmp/vss-resources.txt`.

7. **Update `src/instrumentation.ts`** — the caption-bridge
   poller hits `rtvi-vlm`. Same rename as #6.

8. **Update `src/app/chat/page.tsx`** and `/about/page.tsx` and
   `/prompt/page.tsx` and `/diagnostics/page.tsx` — UI strings reference
   the legacy names (`docker compose logs nvidia-vss-agent`,
   `rtvi-vlm liveness`, etc.). Rename to the chart's service names.

9. **Add a feature gate**: keep the legacy name set behind an env flag
   `CONSOLE_LEGACY_NAMESPACES=1` so the same image works against
   pre-Helm instances (`vss-artesca-int-3` is the only one — useful
   while it's still alive). Default off.

10. **Update `k8s/11-configmap-env.yaml`** — add `VSS_NAMESPACE`
    + every per-service URL override the chart needs. Document each
    knob in `src/lib/cluster-refs.ts` next to its `process.env`
    read.

11. **Update Console deploy-time config** — `isv-labs:scripts/deploy-console.sh`
    ships the ConfigMap; make sure it picks up the helm chart's
    namespace. Probably needs to read `SCALITY_BP_PROFILE` from the
    instance's `.env.local` and set `VSS_NAMESPACE=vss-<profile>` in
    the rendered ConfigMap.

12. **Tests** — `tests/unit/` — anywhere that hardcodes legacy
    service names needs updating. Run `npm test` from the repository root to
    catch them.

13. **Type safety** — `npm run typecheck` from the repository root.

14. **Smoke test** — ideally end-to-end against a fresh helm install,
    but barring that: `npm run dev` from the repository root, set
    `VSS_NAMESPACE=vss-alerts` in `.env.local`, point a manual
    `kubectl port-forward` at the rendered services, exercise the
    Cameras / Prompt / Tuning / Diagnostics pages.

## Files to touch (audit pass — confirm exhaustively before editing)

```
src/lib/cluster-refs.ts              # service URLs + namespace constants
src/app/api/topology/route.ts        # deployment+ns hardcodes (biggest file)
src/app/api/secrets/[key]/route.ts   # namespace fan-out → single ns
src/app/api/prompt/route.ts          # ConfigMap + Deployment patch names
src/app/api/tuning/rtvi/route.ts     # rtvi-vlm Deployment patch
src/app/api/clips/[sensor]/[ts]/route.ts  # sensor-ms URL
src/app/api/clips/preload/route.ts        # sensor-ms URL
src/components/settings/RbacInspector.tsx # namespace list
src/lib/helpers/prompt-apply.ts      # patch helpers
src/instrumentation.ts               # caption-bridge service ref
src/app/chat/page.tsx                # UI strings (nvidia-vss-agent, cosmos-reason)
src/app/about/page.tsx               # service URL string
src/app/prompt/page.tsx              # rtvi-vlm references
src/app/diagnostics/page.tsx         # rtvi-vlm references
tests/unit/*                         # any legacy service-name pins
k8s/11-configmap-env.yaml            # VSS_NAMESPACE + per-service URL knobs
isv-labs:scripts/deploy-console.sh           # render the right namespace into the configmap
```

Run this command from the repo root for a final stale-reference sweep:

```bash
grep -rn "vst\.svc\|rtvi\.svc\|alerts\.svc\|nvidia-vss-single-gpu\|sensor-ms\b\|streamprocessing-ms\b\|nim-cosmos-reason\|nvidia-vss-agent\|alert-worker\b" src/ k8s/ ../isv-labs/scripts/deploy-console.sh
```

The output is your remaining migration backlog.

## Acceptance

- `cd console && npm run typecheck` clean.
- `cd console && npm test` green.
- `src/lib/cluster-refs.ts` reads `process.env.VSS_NAMESPACE` —
  no `vst`/`rtvi`/`alerts` strings anywhere except behind the
  `CONSOLE_LEGACY_NAMESPACES` flag.
- `isv-labs:scripts/deploy-console.sh` renders `VSS_NAMESPACE=vss-<profile>` into
  the deployed ConfigMap based on the per-instance `SCALITY_BP_PROFILE`.
- A manual `kubectl port-forward svc/console-ui 3000` against a real
  `helm install vss-alerts` cluster shows: cameras list, prompt editor,
  topology graph, diagnostics — all populated from the helm-rendered
  service names.

## Reference snippets

`bootstrap-helm-deploy.sh` runs:

```bash
helm upgrade --install "vss-${SCALITY_BP_PROFILE}" \
  -n "vss-${SCALITY_BP_PROFILE}" \
  /tmp/vss-helm/deploy/helm/developer-profiles/dev-profile-${SCALITY_BP_PROFILE} \
  -f values-${SCALITY_BP_MODE}.yaml \
  -f config/vss-helm-values/scality-overlay-base.yaml \
  -f config/vss-helm-values/scality-overlay-${OBJECTSTORE}.yaml \
  -f /tmp/inline-values.yaml
```

The post-install Job in `isv-labs:k8s/nvidia-vss-helm-overlay/` patches
`vst_config.json` to set `enable_cloud_storage: true` + the
`cloud_storage_*` fields (upstream only templates `cloud_storage_endpoint`).
The console reads recordings from S3 via that — the patch must succeed
before the cameras feature works.

---

# Phase 2 enhancements (after the migration above lands)

These are not blockers for the migration — Phase 1 above gets the Console
talking to the helm-rendered cluster. Phase 2 makes the Console
**helm-aware** instead of just helm-compatible. Tackle in any order; each
stands alone.

## 2.1 Profile-aware navigation

The Console assumes alerts/real-time everywhere. With four upstream
profiles, the same UI is wrong on three of them:

| Profile | What's relevant | What's noise |
|---|---|---|
| `base` | chat + diagnostics | incidents, scenarios, alerts |
| `alerts` | full UI as-is | (none) |
| `lvs` | "Library" / summarization page (TBD) | live cameras, incidents |
| `search` | search UI prominent (TBD) | live cameras |

Read `SCALITY_BP_PROFILE` from the deploy-time ConfigMap (already injected
by `isv-labs:scripts/deploy-console.sh`). Gate top-nav entries + landing-page
defaults accordingly. Specific changes:

- `src/app/layout.tsx` — top-nav array becomes a function of profile.
- `src/app/page.tsx` — landing page redirects to profile-appropriate default (chat for base, incidents for alerts, library for lvs, search for search).
- `src/app/incidents/*` — render an "alerts profile required" empty state when `profile !== "alerts"`.

## 2.2 NIM Operator CRDs in Diagnostics

`cosmos-reason2-8b` and `nemotron-nano-9b-v2` are now `NIMService`
resources backed by `NIMCache` model-download CRDs. The Diagnostics page
inspects raw Deployments today; against the helm chart it'll see the
NIMService's underlying Deployment but miss the operator's status fields.

Surface as a top-level Diagnostics section:

```
NIM models
  cosmos-reason2-8b      NIMCache: Ready (24.5 GiB / 24.5 GiB cached)
                         NIMService: Ready (1/1 replicas)
  nemotron-nano-9b-v2    NIMCache: InProgress (6.2 GiB / 18.7 GiB)
                         NIMService: NotReady (waiting for cache)
```

Implementation: `kubectl get nimservice,nimcache -n vss-<profile> -o json`,
parse `.status.state` and `.status.cacheSize` for NIMCache,
`.status.availableReplicas` / `.status.conditions` for NIMService. Keys
in `src/app/diagnostics/page.tsx` and a new
`src/lib/helpers/nim-operator-status.ts`.

## 2.3 post-install patch Job status surfacing

The `vst-config-cloud-storage-patch` Job (in
`isv-labs:k8s/nvidia-vss-helm-overlay/`) is the ONLY thing that flips
`enable_cloud_storage` to true and writes the access keys into
`vst_config.json`. If it doesn't run, recordings silently stay local
(operator sees pods running, no errors, but the S3 bucket stays empty).

Add a first-class indicator on `src/app/diagnostics/page.tsx`:

```
Cloud storage wiring
  patch Job: Succeeded (run 2026-05-12 14:33 UTC)
  enable_cloud_storage: true
  cloud_storage_endpoint: https://s3.us-east-2.amazonaws.com
  cloud_storage_bucket: nvidia-vss-video
```

Failure mode: if the Job's pod logs contain "ConfigMap not found" or
"forbidden", surface the precise failure with a "Re-run patch Job" button.

## 2.4 Helm release awareness (a "Stack" page)

A new `/stack` page that shows:

- Chart version (`helm get metadata vss-<profile> -n vss-<profile> -o json`)
- Release status (`pending-install` / `deployed` / `failed`)
- Profile + mode (from values overrides)
- Pinned upstream commit (read from `config/upstream-vss.env` if mounted
  into the Console pod, otherwise read from a release annotation we set
  at install time)
- "Last upgraded" timestamp
- A "View applied values" disclosure showing the merged values YAML
- A "Rollback to previous revision" admin action (gated by the Console's
  existing auth)

Implementation: Console pod needs `helm` binary in the image (small —
~50 MB) and RBAC to query the cluster's helm-managed Secrets
(`secrets.* / get,list` in `vss-<profile>` ns).

## 2.5 vssIngress toggle awareness

When `vssIngress.enabled=true` the chart emits a single Ingress with
HAProxy path-rewrites; URLs become host-based
(`https://vss-alerts.<ip>.nip.io/agent`, `.../alert-bridge`, etc.).
When disabled (current default) the operator hits NodePorts directly.

Console hardcodes NodePort URLs today. Add a per-instance ConfigMap
read: when `VSSINGRESS_ENABLED=true`, switch URL templates to
`{externalScheme}://{externalHost}/{path}` (read from helm values).
Falls back to NodePort when disabled.

## 2.6 Multi-release support

Today the Console assumes one release per pod. Operators may run
`vss-base` on a chassis and `vss-alerts` on another (showroom + dev
side-by-side). Two paths:

- **Simple**: deploy one Console per release (each with its own
  `VSS_NAMESPACE` env). Operators bookmark per-cluster URLs. No code
  change.
- **Better**: a release picker in the top-bar that switches the
  Console's effective `VSS_NAMESPACE` between deployed releases (read
  from `helm list -A -o json`). Persists in localStorage. Requires
  cross-namespace RBAC for the Console SA.

Pick the simpler path unless a real multi-release demand emerges.

## 2.7 Camera registration two-step against helm chart names

`src/lib/helpers/vst.ts` does:

```
vstAddSensor    → POST http://<host>:30888/vst/api/v1/sensor/add
vstStartStream  → POST http://127.0.0.1:30001/api/v1/proxy/stream/add  (docker-only)
```

On the helm path, `30888` is `vss-vios-ingress.vss-<profile>` and `30001`
is the streamprocessing-ms internal port (now `vss-vios-streamprocessing`).
The "no-op on k8s" comment in step 2 may no longer hold — verify by
checking whether the helm-rendered streamprocessing-ms still requires
the `proxy/stream/add` call after sensor metadata registration. If it
does, the K8s path needs the same two-step flow the docker path runs.

## 2.8 chat/page.tsx + diagnostics + about UI strings

User-visible strings reference docker container names and legacy
deployment names:

- `src/app/chat/page.tsx`: `"docker compose logs nvidia-vss-agent"`
  → `"kubectl logs deploy/vss-agent -n vss-<profile>"` (or `docker compose
  logs vss-agent` on the docker path — Console should know its runtime).
- `src/app/diagnostics/page.tsx`: "rtvi-vlm liveness" → keep,
  but verify the deployment name update.
- `src/app/about/page.tsx`: hardcoded URLs in the service
  table. Read from `cluster-refs.ts` instead.

Mostly cosmetic; bundle with #1.

---

# Tracking

The migration prompt itself is tracked in **ISV-618** under **ISV-460**
(NVIDIA AIDP / VSS / Pyramid). Open Phase 2 as sub-tasks of ISV-618 if
you take them on; close them individually as they ship.
