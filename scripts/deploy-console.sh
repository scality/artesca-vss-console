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

# Mirror to canonical action log so the deployer log viewer can stream
# this run when invoked from the CLI (no spawnDetached capture).
vss_init_action_log "console-deploy"
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
# Provider-aware SSH via lib-remote.sh.
# shellcheck source=lib-remote.sh
source "$SCRIPT_DIR/lib-remote.sh"
# remote_init is called after state files are sourced; defer until state is loaded.
# SSH_USER default is set below for lib-kubectl.sh compatibility.

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

# Initialise provider-aware SSH now that state files are loaded.
if [[ -n "${PUB_IP:-}" ]]; then
  remote_init || { echo "FATAL: remote_init failed — check state file and SSH config" >&2; exit 1; }
fi

# Get kubectl talking to the cluster. Baremetal/DMZ hosts disable SSH TCP
# forwarding (and don't let us edit sshd_config), so the laptop tunnel can't be
# opened there — run kubectl ON THE NODE via rsh instead. Other providers use
# the laptop SSH tunnel. Force node-remote mode anywhere with REMOTE_KUBECTL=1.
if [[ -n "${PUB_IP:-}" ]]; then
  if [[ "${PROVIDER:-}" == "baremetal" || "${REMOTE_KUBECTL:-0}" == "1" ]]; then
    echo "==> kubectl: node-remote mode (provider=${PROVIDER:-?}, TCP forwarding not required)"
    if ! enable_remote_kubectl; then
      echo "FATAL: remote kubectl setup failed. See stderr above." >&2
      exit 1
    fi
  elif ! setup_laptop_kubectl >/dev/null; then
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
  if [ -z "${STATE_SG_ID:-}" ]; then
    if [ "${PROVIDER:-}" = "baremetal" ]; then
      # No AWS Security Group on bare-metal; the console's camera-sim SG-write
      # feature is a no-op here. Use a placeholder so the deploy proceeds.
      STATE_SG_ID="none"
    else
      echo "SG_ID missing from $VSS_STATE_FILE — launch-stack.sh must run first" >&2
      exit 1
    fi
  fi

  NEXTAUTH_SECRET_VAL="$(openssl rand -base64 32)"
  CONSOLE_PASSWORD_VAL="${CONSOLE_PASSWORD:-admin}"

  # Camera-sim SSH key — the camera simulator is the AWS camsim (isv-labs-ec2
  # key-pair), independent of the deploy node's own key (on bare-metal the node
  # key is e.g. pyramid-showroom, which does NOT authorize the camsim). Prefer
  # CAMERA_SIM_KEY_FILE, then the camsim key, then the node KEY_NAME.pem.
  SSH_KEY_FILE="${CAMERA_SIM_KEY_FILE:-$HOME/.ssh/isv-labs-ec2.pem}"
  [ -f "$SSH_KEY_FILE" ] || SSH_KEY_FILE="$HOME/.ssh/${KEY_NAME:-isv-labs-ec2}.pem"
  [ -f "$SSH_KEY_FILE" ] || {
    echo "ERROR: camera-sim SSH key not found (tried CAMERA_SIM_KEY_FILE, isv-labs-ec2.pem, ${KEY_NAME}.pem)" >&2
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
  AUTH_SECRET: "$NEXTAUTH_SECRET_VAL"
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

# Mirror the secrets YAML into the per-instance dir so backup-state.sh can
# include it in GCS state backups (k8s/console/10-secrets.yaml is gitignored).
if [[ -n "${VSS_INSTANCE_DIR:-}" && -d "$VSS_INSTANCE_DIR" ]]; then
  cp -f "$SECRETS_FILE" "$VSS_INSTANCE_DIR/console-secrets.yaml"
  chmod 600 "$VSS_INSTANCE_DIR/console-secrets.yaml"
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

echo "==> ensuring namespace: console (for Secrets)"
kubectl get ns console >/dev/null 2>&1 || kubectl create ns console

echo "==> creating host directory for console PV (/srv/scality/console-data)"
# Two paths:
#   - ARTESCA/MetalK8s (Rocky 8): artesca-os sudoers blocks mkdir/chmod
#     directly but permits salt-call, which runs as root on the node.
#   - Brev/k3s (Ubuntu): no salt, but the ubuntu user has plain sudo.
# Try plain `sudo -n mkdir` first (works on Brev); fall back to salt-call
# (works on ARTESCA). If both fail, warn — the PV mount will fail and the
# operator will see a clear MountVolume error.
if [[ -n "${REMOTE_SSH_TARGET:-}" ]]; then
  if rsh "sudo -n mkdir -p /srv/scality/console-data && sudo -n chmod 0777 /srv/scality/console-data" >/dev/null 2>&1; then
    : # success via direct sudo
  elif rsh "sudo -n salt-call --local --out=quiet cmd.run '
       mkdir -p /srv/scality/console-data &&
       chmod 0777 /srv/scality/console-data
     '" >/dev/null 2>&1; then
    : # success via salt-call (ARTESCA path)
  else
    echo "WARN: could not create /srv/scality/console-data on remote — PV may fail to bind" >&2
  fi
fi

echo "==> applying Secrets"
# Pipe via stdin (not -f <localpath>) so this works in node-remote mode too,
# where the file lives on the laptop, not the node.
kubectl apply -f - < "$SECRETS_FILE"

# Firestore credentials secret (shared by the console pod and the reconcile-agent).
# Sourced from Secret Manager config-store-rw-key (project isv-alliances). Created
# here so it exists before the console Deployment mounts it; reconcile-agent-deploy
# reuses it. Idempotent — skips when already present.
echo "==> ensuring config-store-rw secret (Firestore creds)"
kubectl get namespace console >/dev/null 2>&1 || kubectl create namespace console
if ! kubectl -n console get secret config-store-rw >/dev/null 2>&1; then
  CS_KEY_TMP="$(mktemp)"
  if gcloud secrets versions access latest --secret=config-store-rw-key \
       --project=isv-alliances > "$CS_KEY_TMP" 2>/dev/null && [[ -s "$CS_KEY_TMP" ]]; then
    # Render locally (reads the laptop-side key file), apply via stdin so it
    # works in node-remote mode where the key file isn't on the node.
    if command kubectl -n console create secret generic config-store-rw \
         --from-file=key.json="$CS_KEY_TMP" --dry-run=client -o yaml \
         | kubectl apply -f -; then
      rm -f "$CS_KEY_TMP"
      echo "    created config-store-rw"
    else
      rm -f "$CS_KEY_TMP"
      echo "ERROR: failed to create the config-store-rw secret in ns console." >&2
      exit 1
    fi
  else
    rm -f "$CS_KEY_TMP"
    echo "ERROR: could not fetch config-store-rw-key from Secret Manager (project isv-alliances)." >&2
    echo "       Run 'gcloud auth login' and ensure access to secret config-store-rw-key, then re-run." >&2
    exit 1
  fi
fi

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
  # In-cluster ARTESCA: OBJECTSTORE_ENDPOINT is the external S3 vhost
  # (s3.<base-domain>), which only resolves on hostNetwork pods via the node's
  # hosts file. The console is NOT hostNetwork, so it must reach S3 through the
  # cluster-DNS connector service instead — otherwise the S3 panel NXDOMAINs.
  if [[ "${OBJECTSTORE_MODE:-}" == "artesca" ]]; then
    S3_ENDPOINT_VALUE="http://artesca-data-connector-s3api.zenko.svc.cluster.local:80"
    echo "==> OBJECTSTORE=artesca → console S3 endpoint = in-cluster connector ($S3_ENDPOINT_VALUE)"
  fi
fi
BASE_DOMAIN="${ARTESCA_BASE_DOMAIN:-artesca.isv-lab.local}"
# Grafana (:8443 ARTESCA UI) link surfaced on the console Overview. Operators
# reach :8443 by the node public IP; fall back to the base domain.
GRAFANA_URL_VALUE="https://${PUB_IP:-${PUBLIC_IP:-$BASE_DOMAIN}}:8443/"
if [[ -z "$S3_ENDPOINT_VALUE" ]]; then
  S3_ENDPOINT_VALUE="https://s3.${BASE_DOMAIN}"
fi
if [[ -z "$S3_BUCKET_VALUE" ]]; then
  S3_BUCKET_VALUE="nvidia-vss-video"
fi
echo "==> S3_ENDPOINT=$S3_ENDPOINT_VALUE  S3_BUCKET=$S3_BUCKET_VALUE"

# Derive VSS_NAMESPACE from SCALITY_BP_PROFILE env or .stack-state.env.
# Format: vss-<profile> (e.g. vss-base, vss-alerts, vss-dev-profile-alerts).
# Operators can override by exporting VSS_NAMESPACE before calling this script.
_BP_PROFILE="${SCALITY_BP_PROFILE:-${BP_PROFILE:-base}}"
VSS_NAMESPACE_VALUE="${VSS_NAMESPACE:-vss-${_BP_PROFILE}}"
echo "==> VSS_NAMESPACE=$VSS_NAMESPACE_VALUE (from SCALITY_BP_PROFILE=${_BP_PROFILE})"

# CONSOLE_LEGACY_NAMESPACES: "1" when the workload side uses the legacy manifest
# path (VSS_DEPLOY_PATH=legacy — four namespaces: vst/rtvi/nvidia-vss-single-gpu/alerts).
# "0" when the helm path is active (single vss-<profile> namespace).
# Defaults to "1" (legacy) when VSS_DEPLOY_PATH is absent — matches the existing
# production path and avoids breaking deployed instances that pre-date this axis.
if [[ "${VSS_DEPLOY_PATH:-legacy}" == "helm" ]]; then
  CONSOLE_LEGACY_NAMESPACES="0"
else
  CONSOLE_LEGACY_NAMESPACES="1"
fi
echo "==> CONSOLE_LEGACY_NAMESPACES=$CONSOLE_LEGACY_NAMESPACES (VSS_DEPLOY_PATH=${VSS_DEPLOY_PATH:-legacy})"

# ---------------------------------------------------------------------------
# Resolve workload-namespace list and ensure each namespace exists.
# Then generate console-writer Role + RoleBinding in each workload namespace
# so console-sa can patch Deployments, ConfigMaps, and Jobs there.
# These are NOT in the static k8s/console/01-rbac.yaml (which carries only
# the cluster-scoped console-reader) to avoid namespace-mismatch errors when
# VSS_NAMESPACE differs from a compile-time literal.
# ---------------------------------------------------------------------------

if [[ "$CONSOLE_LEGACY_NAMESPACES" == "0" ]]; then
  _WORKLOAD_NS=("$VSS_NAMESPACE_VALUE" "demo-data" "pyramid-ingress")
else
  _WORKLOAD_NS=("vst" "rtvi" "agent" "alerts" "demo-data" "pyramid-ingress")
fi

echo "==> ensuring workload namespaces: ${_WORKLOAD_NS[*]}"
for ns in "${_WORKLOAD_NS[@]}"; do
  kubectl get ns "$ns" >/dev/null 2>&1 || kubectl create ns "$ns"
done

echo "==> applying console-writer Role + RoleBinding in each workload namespace"
for ns in "${_WORKLOAD_NS[@]}"; do
  kubectl apply -f - <<EOF
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: console-writer
  namespace: ${ns}
rules:
- apiGroups: [""]
  resources: ["configmaps"]
  verbs: ["create", "get", "list", "patch"]
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["get", "list", "patch"]
- apiGroups: ["apps"]
  resources: ["deployments", "statefulsets"]
  verbs: ["get", "list", "patch"]
- apiGroups: ["batch"]
  resources: ["jobs"]
  verbs: ["create", "delete", "get", "list"]
- apiGroups: [""]
  resources: ["pods/exec"]
  verbs: ["get", "create"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: console-writer-binding
  namespace: ${ns}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: console-writer
subjects:
- kind: ServiceAccount
  name: console-sa
  namespace: console
EOF
done

# Kafka advertised-listener: the Confluent broker advertises the SHORT name
# "kafka-kafka", which a non-hostNetwork pod in ns console can't resolve (it
# would need to be in the kafka namespace). Map it to the kafka Service
# ClusterIP via a hostAlias so the console's Kafka health probe resolves the
# advertised name. Re-resolved every deploy — the ClusterIP is per-cluster, so
# this can't be hardcoded in the static manifest.
KAFKA_CLUSTERIP=""
if [[ "$CONSOLE_LEGACY_NAMESPACES" == "0" ]]; then
  KAFKA_CLUSTERIP="$(kubectl -n "$VSS_NAMESPACE_VALUE" get svc kafka-kafka -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)"
  [[ -n "$KAFKA_CLUSTERIP" ]] && echo "==> kafka-kafka ClusterIP=$KAFKA_CLUSTERIP → hostAlias on console deploy"
fi

kubectl kustomize "$CONSOLE_DIR" \
  | python3 -c '
import sys, yaml
new_image = sys.argv[1]
node_hostname = sys.argv[2]
camsim_pub_ip = sys.argv[3]
s3_endpoint_value = sys.argv[4]
s3_bucket_value = sys.argv[5]
vss_namespace_value = sys.argv[6]
console_legacy_namespaces = sys.argv[7]
grafana_url_value = sys.argv[8]
vss_instance_value = sys.argv[9]
kafka_clusterip = sys.argv[10] if len(sys.argv) > 10 else ""
docs = list(yaml.safe_load_all(sys.stdin))
for d in docs:
    if not d:
        continue
    kind = d.get("kind")
    name = d.get("metadata", {}).get("name")
    if kind == "Deployment" and name == "console":
        pspec = d["spec"]["template"]["spec"]
        c = pspec["containers"][0]
        c["image"] = new_image
        c["imagePullPolicy"] = "Never"
        # Map the kafka advertised short-name to its ClusterIP (helm path only).
        if kafka_clusterip:
            aliases = [a for a in pspec.get("hostAliases", [])
                       if "kafka-kafka" not in a.get("hostnames", [])]
            aliases.append({"ip": kafka_clusterip, "hostnames": ["kafka-kafka"]})
            pspec["hostAliases"] = aliases
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
        grafana_url = data.get("GRAFANA_URL", "") or ""
        if grafana_url == "" or "<base-domain>" in grafana_url:
            data["GRAFANA_URL"] = grafana_url_value
        s3_bucket = data.get("S3_BUCKET", "") or ""
        if s3_bucket in ("", "nvidia-vss-video"):
            data["S3_BUCKET"] = s3_bucket_value
        # Render VSS_NAMESPACE from SCALITY_BP_PROFILE if still at default.
        existing_ns = data.get("VSS_NAMESPACE", "") or ""
        if existing_ns in ("", "vss-base"):
            data["VSS_NAMESPACE"] = vss_namespace_value
        # Set CONSOLE_LEGACY_NAMESPACES so the console knows which namespace
        # topology is active ("1" = legacy 4-ns path, "0" = helm single-ns path).
        data["CONSOLE_LEGACY_NAMESPACES"] = console_legacy_namespaces
        existing_inst = data.get("VSS_INSTANCE_NAME", "") or ""
        if existing_inst in ("", "<vss-instance-name>"):
            data["VSS_INSTANCE_NAME"] = vss_instance_value
yaml.safe_dump_all([d for d in docs if d], sys.stdout, default_flow_style=False)
' "$IMAGE_REPO" "$NODE_HOSTNAME" "$CAMSIM_PUB_IP" "$S3_ENDPOINT_VALUE" "$S3_BUCKET_VALUE" \
  "$VSS_NAMESPACE_VALUE" "$CONSOLE_LEGACY_NAMESPACES" "$GRAFANA_URL_VALUE" "$VSS_INSTANCE" \
  "$KAFKA_CLUSTERIP" \
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
