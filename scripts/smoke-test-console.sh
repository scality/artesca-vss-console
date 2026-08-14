#!/usr/bin/env bash
# Local manifest smoke-test for k8s/ against OrbStack K8s.
#
# Purpose:
#   Catch manifest-level bugs (missing ConfigMap keys, broken Service DNS,
#   PVC stuck Pending, Secret refs not present, RBAC bindings pointing at
#   non-existent namespaces, bad hostPort conflicts) in ~30 s instead of
#   the ~10 min remote-cluster rebuild+scp+apply cycle.
#
# NOT a test of:
#   - The console app's behavior (image is a placeholder)
#   - Remote-cluster specifics (MetalK8s-only StorageClass, hostPort 8800)
#
# Usage:
#   scripts/smoke-test-console.sh
#
# Preflight:
#   - OrbStack 2.x with K8s enabled. Check: `kubectl --context orbstack get nodes`
#   - If no `orbstack` context exists, enable K8s from the OrbStack GUI
#     (Settings → Kubernetes → Enable) or `orb start k8s`.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONSOLE_DIR="$REPO_ROOT/k8s"
CONTEXT="orbstack"
NS="console"

# Watched namespaces referenced by the RBAC RoleBindings in 01-rbac.yaml.
# Must exist before kubectl apply or the RoleBinding creates fail.
WATCHED_NS=(vst rtvi agent alerts demo-data pyramid-ingress)

# Placeholder image — unprivileged nginx, listens on :8080, runs as UID 101
# out of the box. Matches the real pod's runAsNonRoot=true constraint
# without needing to patch securityContext. docker.io/library/nginx can't
# be used: it needs root to bind :80 and chown /var/cache/nginx.
PLACEHOLDER_IMAGE="docker.io/nginxinc/nginx-unprivileged:alpine"
PLACEHOLDER_PORT=8080

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

red()   { printf '\033[0;31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[0;33m%s\033[0m\n' "$*"; }

if ! kubectl config get-contexts -o name 2>/dev/null | grep -qx "$CONTEXT"; then
  red "No kubectl context named '$CONTEXT' found."
  red "Enable OrbStack K8s:"
  red "  - OrbStack menubar -> Settings -> Kubernetes -> Enable"
  red "  - or run: orb start k8s"
  exit 1
fi

if ! kubectl --context "$CONTEXT" get --raw=/readyz >/dev/null 2>&1; then
  red "OrbStack K8s API is not ready. Start OrbStack and retry."
  exit 1
fi

yellow "==> context: $CONTEXT"
kubectl --context "$CONTEXT" get nodes -o wide

# ---------------------------------------------------------------------------
# Scratch overlay
# ---------------------------------------------------------------------------

SCRATCH_DIR="$(mktemp -d -t console-smoke-XXXXXX)"
trap 'rm -rf "$SCRATCH_DIR"' EXIT
yellow "==> scratch overlay: $SCRATCH_DIR"

# Render the real kustomization and patch that, rather than listing the manifest
# files again here. This script used to carry its own copy of the resource list —
# in two places, the copy loop and the overlay's `resources:` — and both had
# fallen a file behind k8s/kustomization.yaml. A smoke test whose input is a
# hand-maintained subset cannot catch a mistake in the kustomization, which is
# most of what it exists to catch (ISVD-596).
#
# 10-secrets.yaml is not in the kustomization (real creds, applied imperatively),
# so it is excluded for free. 15-storage.yaml's static MetalK8s PV comes through
# and stays Available and unbound, because the PVC patch below moves console-data
# onto OrbStack's default local-path class.
kubectl kustomize "$CONSOLE_DIR" > "$SCRATCH_DIR/base.yaml"

# Patch 12-pvc.yaml to use OrbStack's default StorageClass instead of the
# MetalK8s-static `console-local` class (which doesn't exist here).
cat > "$SCRATCH_DIR/pvc-patch.yaml" <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: console-data
  namespace: console
spec:
  storageClassName: local-path
EOF

# Patch 20-console.yaml via JSON 6902 ops to:
#   - swap image to placeholder nginx (also done via `images:` override below,
#     this is redundant-safe)
#   - replace the ports list (nginx:alpine listens on 80, not 8800)
#   - drop hostPort (avoid laptop port conflicts)
#   - drop readiness/liveness probes (they target /api/health/self which
#     nginx doesn't serve — pod would never go Ready)
# JSON 6902 is used instead of strategic merge because strategic merge
# APPENDS to the ports list (merge key collision on name=http) rather than
# replacing it.
cat > "$SCRATCH_DIR/deploy-patch.yaml" <<EOF
- op: replace
  path: /spec/template/spec/containers/0/image
  value: $PLACEHOLDER_IMAGE
- op: add
  path: /spec/template/spec/containers/0/imagePullPolicy
  value: IfNotPresent
- op: replace
  path: /spec/template/spec/containers/0/ports
  value:
  - name: http
    containerPort: $PLACEHOLDER_PORT
    protocol: TCP
- op: replace
  path: /spec/template/spec/securityContext
  value:
    runAsNonRoot: true
    runAsUser: 101
# All three probe types, because the placeholder serves neither :8800 nor
# /api/health/self and any surviving probe fails the pod. startupProbe was added
# to 20-console.yaml after this patch was written and was not removed here, so
# the pod stayed unhealthy even once it scheduled. Kubernetes defines exactly
# these three, so this list is complete rather than merely current.
- op: remove
  path: /spec/template/spec/containers/0/startupProbe
- op: remove
  path: /spec/template/spec/containers/0/readinessProbe
- op: remove
  path: /spec/template/spec/containers/0/livenessProbe
EOF

# Service targetPort follows the pod's listener — nginx:alpine on :80.
cat > "$SCRATCH_DIR/svc-patch.yaml" <<EOF
- op: replace
  path: /spec/ports/0/targetPort
  value: $PLACEHOLDER_PORT
EOF

cat > "$SCRATCH_DIR/kustomization.yaml" <<EOF
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
- base.yaml

patches:
- path: pvc-patch.yaml
  target:
    kind: PersistentVolumeClaim
    name: console-data
- path: deploy-patch.yaml
  target:
    kind: Deployment
    name: console
- path: svc-patch.yaml
  target:
    kind: Service
    name: console

# Kustomize image override — mirrors production kustomization.yaml pattern
# but points at the placeholder instead of the CI-built GHCR image.
images:
- name: ghcr.io/scality/artesca-vss-console
  newName: docker.io/library/nginx
  newTag: alpine
EOF

# ---------------------------------------------------------------------------
# Pre-create watched namespaces (RoleBindings in 01-rbac.yaml need them)
# and fake the three required Secrets.
# ---------------------------------------------------------------------------

# Wait for any previous run's namespaces to finish terminating — cleanup
# uses --wait=false to keep the script fast on the happy path, so an
# immediate rerun can race with the Terminating state.
wait_ns_gone() {
  local ns="$1"
  local tries=0
  while kubectl --context "$CONTEXT" get ns "$ns" >/dev/null 2>&1; do
    if [ "$tries" -eq 0 ]; then
      yellow "==> waiting for ns/$ns to finish terminating"
    fi
    tries=$(( tries + 1 ))
    if [ "$tries" -gt 60 ]; then
      red "ns/$ns still Terminating after 60 s — aborting"
      kubectl --context "$CONTEXT" get ns "$ns" -o yaml | tail -20
      exit 1
    fi
    sleep 1
  done
}

yellow "==> ensuring watched namespaces"
for ns in "${WATCHED_NS[@]}" "$NS"; do
  # If the ns exists and is Terminating, wait it out; then recreate.
  phase=$(kubectl --context "$CONTEXT" get ns "$ns" -o jsonpath='{.status.phase}' 2>/dev/null || true)
  if [ "$phase" = "Terminating" ]; then
    wait_ns_gone "$ns"
  fi
  kubectl --context "$CONTEXT" get ns "$ns" >/dev/null 2>&1 \
    || kubectl --context "$CONTEXT" create ns "$ns"
done

yellow "==> creating fake secrets in ns:$NS"
# --dry-run | apply makes this idempotent.
kubectl --context "$CONTEXT" -n "$NS" create secret generic console-auth \
  --from-literal=CONSOLE_PASSWORD=smoke-test \
  --from-literal=AUTH_SECRET=smoke-test-secret-32-bytes-padding \
  --dry-run=client -o yaml | kubectl --context "$CONTEXT" apply -f -

kubectl --context "$CONTEXT" -n "$NS" create secret generic console-ssh \
  --from-literal=id_ed25519="-----BEGIN OPENSSH PRIVATE KEY-----
fake-key-body
-----END OPENSSH PRIVATE KEY-----
" \
  --dry-run=client -o yaml | kubectl --context "$CONTEXT" apply -f -

kubectl --context "$CONTEXT" -n "$NS" create secret generic config-store-rw \
  --from-literal=key.json='{"type":"service_account","project_id":"smoke-test"}' \
  --dry-run=client -o yaml | kubectl --context "$CONTEXT" apply -f -

# ---------------------------------------------------------------------------
# Apply + wait
# ---------------------------------------------------------------------------

yellow "==> kubectl apply -k (scratch overlay)"
kubectl --context "$CONTEXT" apply -k "$SCRATCH_DIR"

yellow "==> waiting for deployment/console to roll out (90s timeout)"
if ! kubectl --context "$CONTEXT" -n "$NS" rollout status deployment/console --timeout=90s; then
  red "==> rollout failed — dumping pod state"
  kubectl --context "$CONTEXT" -n "$NS" get pods -o wide || true
  kubectl --context "$CONTEXT" -n "$NS" describe pod -l app=console || true
  kubectl --context "$CONTEXT" -n "$NS" get events \
    --sort-by='.lastTimestamp' | tail -30 || true
  exit 1
fi

yellow "==> verifying pod readiness"
READY=$(kubectl --context "$CONTEXT" -n "$NS" get pod -l app=console \
  -o jsonpath='{.items[0].status.containerStatuses[0].ready}')
if [ "$READY" != "true" ]; then
  red "pod not Ready (ready=$READY)"
  kubectl --context "$CONTEXT" -n "$NS" describe pod -l app=console
  exit 1
fi

yellow "==> verifying PVC is Bound"
PVC_STATUS=$(kubectl --context "$CONTEXT" -n "$NS" get pvc console-data \
  -o jsonpath='{.status.phase}')
if [ "$PVC_STATUS" != "Bound" ]; then
  red "PVC console-data is $PVC_STATUS, expected Bound"
  kubectl --context "$CONTEXT" -n "$NS" describe pvc console-data
  exit 1
fi

yellow "==> verifying Service selector resolves to a pod"
ENDPOINTS=$(kubectl --context "$CONTEXT" -n "$NS" get endpoints console \
  -o jsonpath='{.subsets[0].addresses[0].ip}' 2>/dev/null || true)
if [ -z "$ENDPOINTS" ]; then
  red "Service/console has no endpoints — selector likely doesn't match any pod"
  kubectl --context "$CONTEXT" -n "$NS" describe svc console
  exit 1
fi

green "==> smoke test PASSED"
green "    deployment/console     ready"
green "    pvc/console-data       Bound"
green "    service/console        endpoints=$ENDPOINTS"

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

yellow "==> cleaning up (deleting ns:console + watched namespaces)"
kubectl --context "$CONTEXT" delete ns "$NS" --wait=false --ignore-not-found
for ns in "${WATCHED_NS[@]}"; do
  kubectl --context "$CONTEXT" delete ns "$ns" --wait=false --ignore-not-found
done

# Cluster-scoped resources (ClusterRole, ClusterRoleBinding) survive ns delete.
kubectl --context "$CONTEXT" delete clusterrolebinding console-reader-binding --ignore-not-found
kubectl --context "$CONTEXT" delete clusterrole console-reader --ignore-not-found

green "==> done"
