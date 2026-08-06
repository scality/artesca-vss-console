# Demo Console — unified operator UI

Next.js 16 operator dashboard for the ARTESCA × VSS stack. Single browser tab
at `:8800` covering service health, live logs, Kafka streams, GPU state, camera
management, VLM prompt editing, and scenario configuration. Phase 0 of
[`docs/console-design.md`](../docs/console-design.md).

## Layout

```
00-namespace.yaml       console namespace (label: scality.com/phase: console)
01-rbac.yaml            ServiceAccount + ClusterRole + 6× Role/RoleBinding
10-secrets.yaml.example template — console password, AWS creds, SSH key
11-configmap-env.yaml   non-secret config (Kafka, Redis, S3, camera-sim, NIM)
12-pvc.yaml             PVC console-data (5 Gi) — SQLite profiles + audit log
20-console.yaml         Deployment + ClusterIP Service, hostPort :8800
kustomization.yaml      apply order + CI image-override block
```

## Prerequisites

1. All six watched namespaces deployed: `vst`, `rtvi`, `agent`, `alerts`,
   `demo-data`, `pyramid-ingress`.
2. Secrets populated — see **Secrets** section below.

## Secrets

Three secrets are required (all gitignored, never committed):

```bash
cp k8s/console/10-secrets.yaml.example k8s/console/10-secrets.yaml
# Edit 10-secrets.yaml — fill in every <...> placeholder:
#   console-auth  : CONSOLE_PASSWORD + AUTH_SECRET  (Auth.js reads AUTH_SECRET;
#                   a Secret carrying only the NEXTAUTH_-prefixed spelling
#                   leaves the pod refusing every request)
#   console-aws   : AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
#                   VSS_INSTANCE_SG_ID, AWS_REGION
#   console-ssh   : id_ed25519 (raw PEM, trailing newline required)
kubectl apply -f k8s/console/10-secrets.yaml
```

## Deploy

```bash
cd k8s/console
cp 10-secrets.yaml.example 10-secrets.yaml
# edit 10-secrets.yaml
kubectl apply -f 10-secrets.yaml
kubectl apply -k .
```

Wait for the pod to become ready:

```bash
kubectl -n console rollout status deploy/console
```

## Access

`http://<ARTESCA-public-IP>:8800`

The EC2 Security Group restricts `:8800` inbound to a curated CIDR list.
Seeded at install with Head office (`203.0.113.0/29`) and
Stéphane's home IP. Add/remove CIDRs from the console itself:
**Settings → Network access**.

## RBAC summary

| Role | Scope | Verbs | Resources |
|------|-------|-------|-----------|
| `console-reader` | Cluster | get, list, watch | pods, pods/log, deployments, statefulsets, configmaps, services, events, namespaces, nodes |
| `console-reader` | Cluster | create | pods/exec (nvidia-smi) |
| `console-reader` | Cluster | get, list | nodes (metrics.k8s.io) |
| `console-writer` | Each of 6 ns | patch | configmaps, deployments, statefulsets |
| `console-writer` | Each of 6 ns | create, delete | jobs |
| `console-writer` | Each of 6 ns | create | pods/exec |

The 6 writable namespaces are: `vst`, `rtvi`, `agent`, `alerts`, `demo-data`,
`pyramid-ingress`.

## Password rotation

**From the UI**: Settings → Password → enter new password → Save. The console
patches `console-auth` via the K8s API and reloads the session middleware.
No pod restart required.

**Imperatively**:

```bash
kubectl -n console delete secret console-auth
# Edit 10-secrets.yaml with the new CONSOLE_PASSWORD
kubectl apply -f k8s/console/10-secrets.yaml
kubectl -n console rollout restart deploy/console
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Pod can't reach Kafka | Wrong service name or namespace | Check `KAFKA_BROKERS` in `11-configmap-env.yaml`; verify `kubectl -n artesca-kafka get svc` |
| `nvidia-smi` exec fails | ClusterRoleBinding missing or pods/exec not in ClusterRole | `kubectl auth can-i create pods/exec --as=system:serviceaccount:console:console-sa` |
| SCP to camera-sim rejected | SSH key PEM missing trailing newline | Ensure `id_ed25519` in `console-ssh` Secret ends with `\n` after `-----END OPENSSH PRIVATE KEY-----` |
| Pod stuck in Pending | PVC not bound | `kubectl -n console describe pvc console-data`; check StorageClass availability |
| 401 on K8s API calls | ServiceAccount token stale | `@kubernetes/client-node` re-reads the token file on every request — check pod RBAC with `kubectl auth can-i` |
