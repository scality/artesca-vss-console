#!/usr/bin/env bash
# Deploy the Demo Console — post-install operator UI at :8800.
#
# Prerequisites:
#   - kubectl works against the local ARTESCA MetalK8s cluster.
#   - k8s/console/10-secrets.yaml exists and has been filled in.
#     Copy from 10-secrets.yaml.example and populate every <...> field:
#       cp k8s/console/10-secrets.yaml.example k8s/console/10-secrets.yaml
#     Then edit it before running this script.
#
# The script is idempotent: re-running it re-applies the manifests and
# waits for the rollout. It never overwrites 10-secrets.yaml.
#
# Env:
#   NODE_IP   — public IP used in the printed access URL (default: read from
#               scripts/.stack-state.env PUBLIC_IP; falls back to <YOUR-NODE-IP>)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-paths.sh
source "$SCRIPT_DIR/lib-paths.sh" "$@"
set -- "${VSS_ARGS[@]:-}"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
CONSOLE_DIR="$REPO_ROOT/k8s/console"
SECRETS_EXAMPLE="$CONSOLE_DIR/10-secrets.yaml.example"
SECRETS_FILE="$CONSOLE_DIR/10-secrets.yaml"

# ---------------------------------------------------------------------------
# State file — read by web/lib/console-deploy.ts to surface stage outcome.
# Minimal JSON: startedAt / finishedAt / exitCode plus a few progress hints.
# All writes are best-effort (python3 -c) so no behavior change if it fails.
# ---------------------------------------------------------------------------

STATE_FILE="$VSS_INSTANCE_DIR/.console-deploy-state.json"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
IMAGE_TAG=""
NAMESPACE_READY=false
PODS_READY=false
HEALTH_ENDPOINT=""

write_state() {
  # $1=finishedAt (or empty for running), $2=exitCode (or empty for running)
  local finished="${1:-}"
  local exit_code="${2:-}"
  python3 - "$STATE_FILE" "$STARTED_AT" "$finished" "$exit_code" \
    "$IMAGE_TAG" "$NAMESPACE_READY" "$PODS_READY" "$HEALTH_ENDPOINT" <<'PY' || true
import json, sys
path, started, finished, exit_code, image_tag, ns_ready, pods_ready, endpoint = sys.argv[1:9]
payload = {
    "startedAt": started,
    "finishedAt": finished if finished else None,
    "exitCode": int(exit_code) if exit_code else None,
    "imageTag": image_tag or None,
    "namespaceReady": ns_ready == "true",
    "podsReady": pods_ready == "true",
    "healthEndpoint": endpoint or None,
}
with open(path, "w") as f:
    json.dump(payload, f)
PY
}

on_exit() {
  local code=$?
  write_state "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$code"
}
trap on_exit EXIT

# Mark "running" immediately so the dashboard sees active state.
write_state "" ""

# ---------------------------------------------------------------------------
# Node IP resolution
# ---------------------------------------------------------------------------

NODE_IP="${NODE_IP:-}"
if [ -z "$NODE_IP" ]; then
  ENV_FILE="$VSS_STATE_FILE"
  if [ -f "$ENV_FILE" ]; then
    # shellcheck source=/dev/null
    source "$ENV_FILE"
    NODE_IP="${PUBLIC_IP:-}"
  fi
fi
NODE_IP="${NODE_IP:-<YOUR-NODE-IP>}"

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------

command -v kubectl >/dev/null || { echo "kubectl not found — install it and configure kubeconfig"; exit 1; }

if ! kubectl get nodes >/dev/null 2>&1; then
  echo "ERROR: kubectl cannot reach the cluster — check KUBECONFIG / cluster state"
  exit 1
fi

# Auto-scaffold 10-secrets.yaml on first deploy. Operator rotates values
# via the /secrets page afterwards. The file is gitignored.
if [ ! -f "$SECRETS_FILE" ]; then
  echo "==> scaffolding $SECRETS_FILE (first deploy)"

  # IAM identity for the console's Network-access panel. If the caller's
  # AWS principal can't create the IAM user (common with SSO read-only
  # roles), fall back to empty creds — the console deploys, the Network
  # access panel shows a "credentials not configured" banner, and the
  # operator fills them via /secrets later.
  CONSOLE_IAM_USER=""
  CONSOLE_IAM_ACCESS_KEY_ID=""
  CONSOLE_IAM_SECRET_ACCESS_KEY=""
  if [ "${SKIP_CONSOLE_IAM:-0}" = "1" ]; then
    echo "    SKIP_CONSOLE_IAM=1 set — leaving AWS creds empty"
  elif IAM_ENV="$("$SCRIPT_DIR/ensure-console-iam.sh" --instance "$VSS_INSTANCE" 2>&1)"; then
    # shellcheck disable=SC2046
    eval "$(echo "$IAM_ENV" | grep -E '^CONSOLE_IAM_')"
  else
    echo "$IAM_ENV" >&2
    echo "WARN: ensure-console-iam.sh failed — continuing with empty AWS creds." >&2
    echo "      Fill AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY via /secrets after login," >&2
    echo "      or rerun after granting the IAM policy shown above." >&2
  fi

  # SG id + region pulled from the instance's stack-state.
  STATE_SG_ID="${SG_ID:-}"
  STATE_AWS_REGION="${AWS_REGION:-us-west-2}"
  if [ -f "$VSS_STATE_FILE" ]; then
    # shellcheck source=/dev/null
    source "$VSS_STATE_FILE"
    STATE_SG_ID="${SG_ID:-$STATE_SG_ID}"
    STATE_AWS_REGION="${AWS_REGION:-$STATE_AWS_REGION}"
  fi
  : "${STATE_SG_ID:?SG_ID missing from $VSS_STATE_FILE — launch-stack.sh must run first}"

  NEXTAUTH_SECRET_VAL="$(openssl rand -base64 32)"
  CONSOLE_PASSWORD_VAL="${CONSOLE_PASSWORD:-admin}"

  # Camera-sim SSH key — reuse the EC2 key-pair file (same pem authorizes
  # artesca-os on both hosts per repo convention).
  SSH_KEY_FILE="${CAMERA_SIM_KEY_FILE:-$HOME/.ssh/${KEY_NAME:-isv-nvidia-vss}.pem}"
  [ -f "$SSH_KEY_FILE" ] || {
    echo "ERROR: $SSH_KEY_FILE missing — cannot embed camera-sim SSH key" >&2
    exit 1
  }
  # Indent each line by 4 spaces to sit under the | block scalar.
  SSH_KEY_BLOCK="$(sed 's/^/    /' "$SSH_KEY_FILE")"

  umask 077
  cat > "$SECRETS_FILE" <<EOF
# Auto-generated by scripts/deploy-console.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Rotate any field via the console /secrets page. Gitignored.
---
apiVersion: v1
kind: Secret
metadata:
  name: console-auth
  namespace: console
type: Opaque
stringData:
  CONSOLE_PASSWORD: "$CONSOLE_PASSWORD_VAL"
  NEXTAUTH_SECRET: "$NEXTAUTH_SECRET_VAL"
---
apiVersion: v1
kind: Secret
metadata:
  name: console-aws
  namespace: console
type: Opaque
stringData:
  AWS_ACCESS_KEY_ID: "$CONSOLE_IAM_ACCESS_KEY_ID"
  AWS_SECRET_ACCESS_KEY: "$CONSOLE_IAM_SECRET_ACCESS_KEY"
  AWS_SESSION_TOKEN: ""
  VSS_INSTANCE_SG_ID: "$STATE_SG_ID"
  AWS_REGION: "$STATE_AWS_REGION"
---
apiVersion: v1
kind: Secret
metadata:
  name: console-ssh
  namespace: console
type: Opaque
stringData:
  id_ed25519: |
$SSH_KEY_BLOCK
EOF
  chmod 600 "$SECRETS_FILE"
  echo "    wrote $SECRETS_FILE (password=$CONSOLE_PASSWORD_VAL, iam=$CONSOLE_IAM_USER)"
fi

# Catch placeholder-only inputs from a partial hand-edit.
if grep -q '<change-me>\|<openssl rand\|<AKIA\|<secret>\|<base64-encoded-key-body>\|<camera-sim-public-ip>\|<id>' "$SECRETS_FILE" 2>/dev/null; then
  echo "ERROR: $SECRETS_FILE still contains placeholder values."
  echo "Edit it and replace every <...> field before deploying."
  exit 1
fi

# ---------------------------------------------------------------------------
# Check whether a console pod is already running (skip redundant full wait)
# ---------------------------------------------------------------------------

ALREADY_RUNNING=0
if kubectl -n console get deployment console >/dev/null 2>&1; then
  READY=$(kubectl -n console get deployment console \
    -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
  if [ "${READY:-0}" -ge 1 ]; then
    ALREADY_RUNNING=1
    echo "==> console deployment already running (${READY} ready replica(s)) — re-applying"
  fi
fi

# ---------------------------------------------------------------------------
# Apply the secrets (pre-apply required; kustomize skips non-kustomization files)
# ---------------------------------------------------------------------------

echo "==> applying Secrets"
kubectl apply -f "$SECRETS_FILE"

# ---------------------------------------------------------------------------
# Image pullability preflight
# ---------------------------------------------------------------------------
# The console manifest pulls from ghcr.io/scality/isv-nvidia-vss/console.
# No imagePullSecret is wired up (matches the alert-worker pattern), so the
# package must be public — otherwise the pod lands in ImagePullBackOff.
# Test anon pullability; on failure, surface the two fixes and bail early.

IMAGE_REPO="ghcr.io/scality/isv-nvidia-vss/console"
GHCR_TOKEN="$(curl -sf "https://ghcr.io/token?scope=repository:scality/isv-nvidia-vss/console:pull" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' 2>/dev/null || true)"
if [ -n "$GHCR_TOKEN" ]; then
  HTTP_CODE=$(curl -so /dev/null -w "%{http_code}" -H "Authorization: Bearer $GHCR_TOKEN" \
    "https://ghcr.io/v2/scality/isv-nvidia-vss/console/manifests/latest" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "000" ]; then
    echo
    echo "ERROR: ${IMAGE_REPO}:latest is not anonymously pullable (HTTP ${HTTP_CODE})."
    echo
    echo "The cluster has no imagePullSecret wired for GHCR, so the pod will"
    echo "ImagePullBackOff. Pick one fix:"
    echo
    echo "  A) Make the package public (simplest; matches alert-worker):"
    echo "       gh api --method PATCH \\"
    echo "         /orgs/scality/packages/container/isv-nvidia-vss%2Fconsole \\"
    echo "         -f visibility=public"
    echo
    echo "  B) Keep private + add an imagePullSecret:"
    echo "       kubectl -n console create secret docker-registry ghcr-login \\"
    echo "         --docker-server=ghcr.io \\"
    echo "         --docker-username=stef9github \\"
    echo "         --docker-password=\$GHCR_PAT \\"
    echo "         --docker-email=stef.richard@gmail.com"
    echo "       # Then edit k8s/console/20-console.yaml and add under spec.template.spec:"
    echo "       #   imagePullSecrets: [{ name: ghcr-login }]"
    echo
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Apply the full kustomize stack
# ---------------------------------------------------------------------------

echo "==> applying kustomize stack (k8s/console)"
kubectl apply -k "$CONSOLE_DIR"

# Resolve the image tag used by the just-applied manifest for the state file.
IMAGE_TAG="$(kubectl -n console get deployment console \
  -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true)"
NAMESPACE_READY=true
write_state "" ""

# ---------------------------------------------------------------------------
# Rollout wait
# ---------------------------------------------------------------------------

echo "==> waiting for console deployment to roll out"
kubectl -n console rollout status deployment/console --timeout=5m

PODS_READY=true
HEALTH_ENDPOINT="http://${NODE_IP}:8800/api/health/self"
write_state "" ""

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo
echo "==================================================================="
echo "=== Console deployed"
echo "==================================================================="
echo
echo "  Access:   http://${NODE_IP}:8800"
echo "  Login:    CONSOLE_PASSWORD from k8s/console/10-secrets.yaml"
echo "  Kiosk:    http://${NODE_IP}:8800?mode=kiosk  (check box at login)"
echo
echo "Run scripts/validate-console.sh to confirm the deployment is healthy."
