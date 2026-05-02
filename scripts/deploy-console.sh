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

# Laptop-side kubectl — apiserver :6443 isn't laptop-reachable, so fetch
# admin.conf over SSH and tunnel through. Same pattern as deploy-stack.sh.
# Teardown is folded into on_exit (set below) so we don't stomp on traps.
# shellcheck source=lib-kubectl.sh
source "$SCRIPT_DIR/lib-kubectl.sh"

# Source env files in the same order as launch-stack.sh / install-artesca.sh:
# global scripts/.env.local first (ARTESCA_BASE_DOMAIN, shared creds), then
# per-instance .env.local (S3 creds), then per-instance .stack-state.env
# (PUB_IP, SG_ID, AWS_REGION). Each stage overrides the previous.
GLOBAL_ENV_LOCAL="$SCRIPT_DIR/.env.local"
# shellcheck disable=SC1090
[[ -f "$GLOBAL_ENV_LOCAL" ]] && source "$GLOBAL_ENV_LOCAL"
# shellcheck disable=SC1090
[[ -f "$VSS_ENV_LOCAL" ]] && source "$VSS_ENV_LOCAL" || true
if [[ -f "$VSS_STATE_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$VSS_STATE_FILE"
fi
: "${SSH_USER:=artesca-os}"

# ---------------------------------------------------------------------------
# State file — read by deployer/lib/console-deploy.ts to surface stage outcome.
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

OVERLAY_DIR=""
on_exit() {
  local code=$?
  [[ -n "$OVERLAY_DIR" ]] && rm -rf "$OVERLAY_DIR"
  write_state "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$code"
  type teardown_laptop_kubectl >/dev/null 2>&1 && teardown_laptop_kubectl 2>/dev/null || true
}
trap on_exit EXIT

# Mark "running" immediately so the dashboard sees active state.
write_state "" ""

# Open the SSH tunnel + kubeconfig once the state-file trap is in place.
if [[ -n "${PUB_IP:-}" ]]; then
  if ! setup_laptop_kubectl >/dev/null; then
    echo "FATAL: laptop kubectl setup failed. See stderr above." >&2
    exit 1
  fi
fi

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
  SSH_KEY_FILE="${CAMERA_SIM_KEY_FILE:-$HOME/.ssh/${KEY_NAME:-isv-nvidia-nvidia-vss}.pem}"
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

echo "==> ensuring namespaces (Secrets + RoleBindings across workload ns)"
# Console Secrets land in ns: console. The RBAC bindings in 01-rbac.yaml
# grant the console-sa read access in ns: vst, rtvi, agent, alerts,
# demo-data, pyramid-ingress. Pre-create any that don't exist yet so
# RoleBinding creation doesn't fail.
for ns in console vst rtvi agent alerts demo-data pyramid-ingress; do
  kubectl get ns "$ns" >/dev/null 2>&1 || kubectl create ns "$ns"
done

echo "==> creating host directory for console PV (/srv/scality/console-data)"
# Same salt-call pattern as bootstrap-rtvi.sh + bootstrap-vst.sh —
# artesca-os sudoers blocks mkdir/chmod but permits salt-call, which
# runs as root on the node.
KEY_PATH_HOST="${KEY_PATH:-$HOME/.ssh/${KEY_NAME:-isv-nvidia-nvidia-vss}.pem}"
ssh -i "$KEY_PATH_HOST" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
  -o ConnectTimeout=10 "${SSH_USER:-artesca-os}@$PUB_IP" \
  "sudo -n salt-call --local --out=quiet cmd.run '
     mkdir -p /srv/scality/console-data &&
     chmod 0777 /srv/scality/console-data
   '" >/dev/null 2>&1 || {
  echo "WARN: could not create /srv/scality/console-data via salt-call — PV may fail to bind" >&2
}

echo "==> applying Secrets"
kubectl apply -f "$SECRETS_FILE"

# ---------------------------------------------------------------------------
# Build + sideload the console image onto the node's containerd store.
# Avoids the GHCR auth/visibility dance entirely — kubelet finds the image
# in its local cache and never reaches out to a registry.
# ---------------------------------------------------------------------------

echo "==> provisioning console image (build on laptop, sideload to node)"
bash "$SCRIPT_DIR/build-console-image.sh" --instance "$VSS_INSTANCE"

LOCAL_IMAGE_TAG_FILE="$VSS_INSTANCE_DIR/.console-image-tag"
[[ -f "$LOCAL_IMAGE_TAG_FILE" ]] || {
  echo "ERROR: $LOCAL_IMAGE_TAG_FILE missing — build-console-image.sh did not run to completion" >&2
  exit 1
}
LOCAL_IMAGE_TAG="$(tr -d '[:space:]' < "$LOCAL_IMAGE_TAG_FILE")"
LOCAL_IMAGE_NAME="console.local"

# ---------------------------------------------------------------------------
# Apply the kustomize stack with the local image override. A tmp overlay
# rewrites ghcr.io/scality/isv-nvidia-nvidia-vss/console:latest ->
# console.local:<git-hash> and forces imagePullPolicy: Never so kubelet
# never attempts a registry pull.
# ---------------------------------------------------------------------------

echo "==> applying kustomize stack (image override: ${LOCAL_IMAGE_NAME}:${LOCAL_IMAGE_TAG})"
# Render the base, then patch four things in-memory:
#   1. console Deployment container: image -> local tag + Never
#   2. console-data PV nodeAffinity: hostname placeholder -> live node
#   3. console-env ConfigMap CAMERA_SIM_HOST: placeholder -> camera-sim EIP
#   4. console-env ConfigMap S3_ENDPOINT: <base-domain> -> ARTESCA_BASE_DOMAIN
# Avoids kustomize's "new root cannot be absolute" issue when overlay
# resources: point outside the overlay directory.
IMAGE_REPO="${LOCAL_IMAGE_NAME}:${LOCAL_IMAGE_TAG}"
NODE_HOSTNAME="$(kubectl get nodes -o jsonpath='{.items[0].metadata.name}')"

# Camera-sim substitution. The console talks to the camera-sim's control
# plane on :8080 and mediamtx API on :9997; both need the EC2 public IP.
# Source: scripts/camera-sim-instances/<camsim>/.camera-sim-state.env (PUB_IP).
CAMSIM_INSTANCE_NAME="${CAMSIM_INSTANCE:-main}"
CAMSIM_STATE="$SCRIPT_DIR/camera-sim-instances/$CAMSIM_INSTANCE_NAME/.camera-sim-state.env"
CAMSIM_PUB_IP=""
if [[ -f "$CAMSIM_STATE" ]]; then
  # shellcheck disable=SC1090
  CAMSIM_PUB_IP="$(awk -F= '/^PUB_IP=/{print $2; exit}' "$CAMSIM_STATE")"
fi
if [[ -z "$CAMSIM_PUB_IP" ]]; then
  echo "WARN: no camera-sim PUB_IP found at $CAMSIM_STATE" >&2
  echo "      Launch a camera-sim first (scripts/launch-camera-sim.sh) or set" >&2
  echo "      CAMSIM_INSTANCE to point at an existing one. The console's" >&2
  echo "      Cameras page will show an error until CAMERA_SIM_HOST is set." >&2
  CAMSIM_PUB_IP="<camera-sim-public-ip>"
else
  echo "==> camera-sim=$CAMSIM_INSTANCE_NAME pub IP=$CAMSIM_PUB_IP"
fi

# Object-store endpoint + bucket. Unified contract:
#   $VSS_INSTANCE_DIR/.objectstore.env (written by scripts/install-objectstore/*)
#   provides OBJECTSTORE_ENDPOINT and OBJECTSTORE_BUCKET regardless of mode
#   (artesca, aws-s3, none). When that file is absent, fall back to the legacy
#   ARTESCA_BASE_DOMAIN-derived URL so the AWS+ARTESCA happy path keeps working
#   on stacks deployed before this refactor.
OBJECTSTORE_ENV_FILE="$VSS_INSTANCE_DIR/.objectstore.env"
S3_ENDPOINT_VALUE=""
S3_BUCKET_VALUE=""
if [[ -f "$OBJECTSTORE_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$OBJECTSTORE_ENV_FILE"
  S3_ENDPOINT_VALUE="${OBJECTSTORE_ENDPOINT:-}"
  S3_BUCKET_VALUE="${OBJECTSTORE_BUCKET:-}"
  echo "==> objectstore=$OBJECTSTORE_ENV_FILE (mode=${OBJECTSTORE_MODE:-?})"
fi
BASE_DOMAIN="${ARTESCA_BASE_DOMAIN:-artesca.isv-lab.local}"
if [[ -z "$S3_ENDPOINT_VALUE" ]]; then
  S3_ENDPOINT_VALUE="https://s3.${BASE_DOMAIN}"
fi
if [[ -z "$S3_BUCKET_VALUE" ]]; then
  S3_BUCKET_VALUE="nvidia-vss-video"
fi
echo "==> S3_ENDPOINT=$S3_ENDPOINT_VALUE  S3_BUCKET=$S3_BUCKET_VALUE"

kubectl kustomize "$CONSOLE_DIR" \
  | python3 -c '
import sys, yaml
new_image = sys.argv[1]
node_hostname = sys.argv[2]
camsim_pub_ip = sys.argv[3]
s3_endpoint_value = sys.argv[4]
s3_bucket_value = sys.argv[5]
docs = list(yaml.safe_load_all(sys.stdin))
for d in docs:
    if not d:
        continue
    kind = d.get("kind")
    name = d.get("metadata", {}).get("name")
    if kind == "Deployment" and name == "console":
        c = d["spec"]["template"]["spec"]["containers"][0]
        c["image"] = new_image
        c["imagePullPolicy"] = "Never"
    elif kind == "PersistentVolume" and name == "console-data":
        terms = d["spec"]["nodeAffinity"]["required"]["nodeSelectorTerms"]
        for t in terms:
            for expr in t.get("matchExpressions", []):
                if expr.get("key") == "kubernetes.io/hostname":
                    expr["values"] = [node_hostname]
    elif kind == "ConfigMap" and name == "console-env":
        data = d.setdefault("data", {})
        # Only substitute if the committed value is still the placeholder —
        # dont clobber an operator override.
        if data.get("CAMERA_SIM_HOST") in (None, "<camera-sim-public-ip>", ""):
            data["CAMERA_SIM_HOST"] = camsim_pub_ip
        s3_endpoint = data.get("S3_ENDPOINT", "") or ""
        if s3_endpoint == "" or "<base-domain>" in s3_endpoint:
            data["S3_ENDPOINT"] = s3_endpoint_value
        s3_bucket = data.get("S3_BUCKET", "") or ""
        if s3_bucket in ("", "nvidia-vss-video"):
            data["S3_BUCKET"] = s3_bucket_value
yaml.safe_dump_all([d for d in docs if d], sys.stdout, default_flow_style=False)
' "$IMAGE_REPO" "$NODE_HOSTNAME" "$CAMSIM_PUB_IP" "$S3_ENDPOINT_VALUE" "$S3_BUCKET_VALUE" \
  | kubectl apply -f -

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
