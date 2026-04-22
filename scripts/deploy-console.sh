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
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
CONSOLE_DIR="$REPO_ROOT/k8s/console"
SECRETS_EXAMPLE="$CONSOLE_DIR/10-secrets.yaml.example"
SECRETS_FILE="$CONSOLE_DIR/10-secrets.yaml"

# ---------------------------------------------------------------------------
# Node IP resolution
# ---------------------------------------------------------------------------

NODE_IP="${NODE_IP:-}"
if [ -z "$NODE_IP" ]; then
  ENV_FILE="$SCRIPT_DIR/.stack-state.env"
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

# Abort if 10-secrets.yaml is missing — never create it automatically.
if [ ! -f "$SECRETS_FILE" ]; then
  echo
  echo "ERROR: $SECRETS_FILE not found."
  echo
  echo "Fill in Secrets first:"
  echo "  cp $SECRETS_EXAMPLE $SECRETS_FILE"
  echo "  # Edit $SECRETS_FILE — replace every <...> placeholder"
  echo "  # Then re-run: $0"
  echo
  exit 1
fi

# Warn if the example placeholder strings are still present.
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
# Apply the full kustomize stack
# ---------------------------------------------------------------------------

echo "==> applying kustomize stack (k8s/console)"
kubectl apply -k "$CONSOLE_DIR"

# ---------------------------------------------------------------------------
# Rollout wait
# ---------------------------------------------------------------------------

echo "==> waiting for console deployment to roll out"
kubectl -n console rollout status deployment/console --timeout=5m

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
