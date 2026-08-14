# Deploying the console

Kubernetes manifests for the ARTESCA VSS operator console — a `Deployment` in
namespace `console` serving `:8800`. Design rationale and the operator-facing
intent of each page: [`docs/console-design.md`](../docs/console-design.md).

## Layout

```text
00-namespace.yaml                console namespace
01-rbac.yaml                     ServiceAccount, a read-only cluster-wide
                                 ClusterRole, and a Role for the console's own
                                 two Secrets, pinned by name
02-workload-rbac.yaml.example    console-writer (per-workload-namespace WRITE
                                 grant) + console-exec (pods/exec, VSS ns only).
                                 Not in the kustomization; see below
10-secrets.yaml.example          template — console password and SSH key
11-configmap-env.yaml            non-secret config (Kafka, Redis, S3, NIM, …)
12-pvc.yaml                      PVC console-data (5 Gi) — SQLite + audit log
15-storage.yaml                  storage-related resources
20-console.yaml                  Deployment + Service
30-test-footage.yaml             test-footage PVC and server
kustomization.yaml               apply order + image override
```

## Prerequisites

A cluster with VSS deployed. The console resolves namespaces two ways:

- **Helm layout (default)** — `vss-<profile>`.
- **Pre-Helm layout** — set `CONSOLE_LEGACY_NAMESPACES=1`, which reverts to the
  per-component namespaces (`vst`, `rtvi`, `agent`, `alerts`, `demo-data`,
  `pyramid-ingress`).

Namespaces and service names are resolved in
[`src/lib/cluster-refs.ts`](../src/lib/cluster-refs.ts). A deployment that names
things differently will have pages report a component as absent when it is
running — see the repository's issues.

## 1. Secrets

None has ever been committed; `.gitignore` and the repository's gitleaks scan
keep it that way.

```bash
cp k8s/10-secrets.yaml.example k8s/10-secrets.yaml
# Fill in every <...> placeholder:
#   console-auth : CONSOLE_PASSWORD + AUTH_SECRET
#                  Auth.js reads AUTH_SECRET. A Secret carrying only the
#                  NEXTAUTH_-prefixed spelling leaves the pod refusing every
#                  request while instrumentation logs "missing env vars".
#   console-ssh  : id_ed25519 (raw PEM, trailing newline required)
kubectl apply -f k8s/10-secrets.yaml
```

## 2. Workload RBAC — required, and easy to miss

`01-rbac.yaml` grants cluster-wide **read** and the console's own namespace for
secrets. It grants no write anywhere. Every write the console performs targets a
workload namespace: the camera ConfigMap, scenario edits, the `/prompt` model
swap, and `/tuning`'s Deployment env patches.

**Without `console-writer`, the console reads correctly and fails on every
write** — at runtime, as a 403 behind a Save button, not at deploy time.

```bash
for ns in vss-alerts; do          # each namespace the console is pointed at
  sed "s/<WORKLOAD_NAMESPACE>/$ns/g" k8s/02-workload-rbac.yaml.example \
    | kubectl apply -f -
done

# Verify — a RoleBinding in the wrong namespace applies cleanly and grants nothing
kubectl auth can-i patch configmaps \
  --as=system:serviceaccount:console:console-sa -n vss-alerts
```

It is an example rather than part of the kustomization because the namespace is
not knowable in advance, and a hardcoded name fails to apply on any cluster that
chose differently.

## 3. Deploy

```bash
kubectl apply -k k8s/
kubectl -n console rollout status deploy/console
```

⚠ **`kustomization.yaml` pins the image to a package you may not be able to
pull.** Override it with the image you built:

```bash
cd k8s && kustomize edit set image ghcr.io/scality/artesca-vss-console=<your-image>
```

## Access

The console serves `:8800` inside the cluster. Expose it the way your cluster
normally exposes an internal service — an Ingress, a `LoadBalancer`, or
`kubectl port-forward`:

```bash
kubectl -n console port-forward deploy/console 8800:8800
```

⚠ **Do not expose it to an untrusted network.** Authentication is a single
shared password, the RBAC above is broad, and some pages render credentials in
clear. [`SECURITY.md`](../SECURITY.md) lists these in full.

## RBAC summary

What `01-rbac.yaml` and the workload example actually grant:

| Role | Scope | Verbs | Resources |
| --- | --- | --- | --- |
| `console-reader` | Cluster | get, list, watch | pods, pods/log, configmaps, services, events, namespaces, nodes |
| `console-reader` | Cluster | get, list, watch | deployments, statefulsets (`apps`) |
| `console-reader` | Cluster | get, list | nodes (`metrics.k8s.io`) |
| `console-secrets` | ns `console` | get, patch | secrets — **`console-auth`, `console-ssh` only** |
| `console-writer` | each workload ns | create, patch | configmaps |
| `console-writer` | each workload ns | patch | deployments, statefulsets (`apps`) |
| `console-writer` | each workload ns | create, delete | jobs (`batch`) |
| `console-writer` | each workload ns | get | secrets |
| `console-writer` | each workload ns | patch | secrets — **the rotatable ones only** |
| `console-exec` | **VSS ns only** | get, create | pods/exec |

The cluster-scoped Role is read-only: no exec, no write verb. Three things above
are worth understanding before copying this into another cluster.

**`console-exec` is the grant to think about.** Exec is arbitrary command
execution in the target pod. Everything that needs it is observability, in one
namespace: a `df` on the VST recording cache, `pg_isready` and two `psql` counts,
and `redis-cli ping` / `info`. Skip the Role and the console still runs — the
storage-cache figure, the Postgres row and the Redis row on `/topology` read
unknown. GPU state is not a reason for it: `/api/gpu` reads Prometheus and the
`/diagnostics` nvidia-smi test goes over SSH to the node.

**Secret writes are pinned by name.** A bare `secrets: patch` lets the console
rewrite every Secret in the namespace; `/secrets` rotates a known handful, so
each grant names them. `get` in a workload namespace is deliberately *not*
pinned — the LLM health probe follows whatever `secretKeyRef` a container
declares and cannot know the name in advance. That read is fail-soft, so
restricting it degrades the probe rather than breaking a page.

**No `list` on secrets anywhere.** Nothing in the console enumerates them: the
only API calls are `readNamespacedSecret` and `patchNamespacedSecret`, both by
name. `list` also cannot be restricted by `resourceNames`, so granting it would
hand back exactly the enumeration the pinned rules withhold.

## Password rotation

**From the UI**: `/secrets` → rotate. The console patches `console-auth` through
the Kubernetes API; no pod restart required.

**Imperatively**:

```bash
kubectl -n console delete secret console-auth
# edit k8s/10-secrets.yaml with the new CONSOLE_PASSWORD
kubectl apply -f k8s/10-secrets.yaml
kubectl -n console rollout restart deploy/console
```

## Troubleshooting

| Symptom | Likely cause | Check |
| --- | --- | --- |
| Save returns 403; reads all work | `console-writer` not applied, or applied to the wrong namespace | `kubectl auth can-i patch configmaps --as=system:serviceaccount:console:console-sa -n <ns>` |
| Pod `ImagePullBackOff` | `kustomization.yaml` points at a package you cannot pull | `kustomize edit set image` with your own build |
| Every request refused, logs say `missing env vars: AUTH_SECRET` | Secret carries only `NEXTAUTH_SECRET` — Auth.js reads nothing from that spelling. `10-secrets.yaml.example` carries the right name; a Secret created before it did may not | Add `AUTH_SECRET` to `console-auth` |
| Pod stuck in `Pending` | PVC not bound | `kubectl -n console describe pvc console-data`; check the StorageClass |
| A component reads as absent while it is running | Namespace or service name differs from `cluster-refs.ts` | Compare against your layout; `CONSOLE_LEGACY_NAMESPACES=1` for the pre-Helm one |
| Cannot reach Kafka | Wrong broker service name | Check `KAFKA_BROKERS` in `11-configmap-env.yaml` |
| `/topology` storage-cache, Postgres and Redis rows read unknown | `console-exec` Role not applied in the VSS namespace | `kubectl auth can-i create pods --subresource=exec --as=system:serviceaccount:console:console-sa -n <vss-ns>` — ⚠ use `--subresource`; `can-i create pods/exec` answers about `pods` and reports the opposite |
| 401 on Kubernetes API calls | ServiceAccount token stale | The client re-reads the token file per request — check the binding with `kubectl auth can-i` |
