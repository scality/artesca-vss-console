#!/usr/bin/env bash
# dev-console.sh — run the in-cluster console LOCALLY against a live instance's
# cluster, with full network reachability via sshuttle.
#
# Why sshuttle (not per-service `ssh -L`): the console addresses many in-cluster
# services (K8s API, Kafka, VST, redis, …) by their cluster IPs / DNS names.
# sshuttle routes the cluster's node-subnet + pod + service CIDRs through the
# node in ONE shot, so the laptop reaches them by their real addresses — the
# K8s apiserver cert stays valid (no insecure-skip), and Kafka's advertised
# listener resolves to a routable address. One transparent route beats N tunnels.
#
# Usage:
#   scripts/dev-console.sh --instance <name> [--port N] [--no-dev] [--with-hosts]
#
#   --instance <name>   instance under scripts/instances/<name>/ (required)
#   --port <N>          dev-server port (default 5003). Use another (e.g. 5013)
#                       to run ALONGSIDE the menubar-managed console on :5003.
#   --no-dev            set up sshuttle + .env.local + hosts but don't start a
#                       server — then restart the menubar console so it reloads
#                       .env.local and uses the wiring.
#   --with-hosts        append the Kafka advertised-name alias to /etc/hosts
#                       (sudo; removed on exit). Without it, Kafka stays
#                       "unreachable" — see the printed note.
#
# Requirements: sshuttle (`brew install sshuttle`), the instance's SSH key.
# sshuttle needs sudo to program routes — it prompts interactively.
#
# Known gaps (printed at the end too):
#   - Prometheus: ARTESCA fronts it with auth (401); the console's promQuery
#     sends no credentials, so Prometheus tiles stay unreachable even here.
#   - camera-sim: a separate EC2 instance, not in this cluster.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
# shellcheck source=lib-remote.sh
source "$HERE/lib-remote.sh"

INSTANCE=""
START_DEV=1
WITH_HOSTS=0
DEV_PORT=5003
while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance) INSTANCE="$2"; shift 2 ;;
    --instance=*) INSTANCE="${1#--instance=}"; shift ;;
    --no-dev) START_DEV=0; shift ;;
    --with-hosts) WITH_HOSTS=1; shift ;;
    --port) DEV_PORT="$2"; shift 2 ;;
    --port=*) DEV_PORT="${1#--port=}"; shift ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$INSTANCE" ]] || { echo "error: --instance <name> required" >&2; exit 2; }

INST_DIR="$REPO_ROOT/scripts/instances/$INSTANCE"
[[ -d "$INST_DIR" ]] || { echo "error: $INST_DIR not found" >&2; exit 2; }

command -v sshuttle >/dev/null || { echo "error: sshuttle not installed (brew install sshuttle)" >&2; exit 2; }

# Pre-flight the dev-server port BEFORE any setup, so a busy port doesn't make us
# mount sshuttle + the hosts alias only to have the dev server fail (its exit
# would then trigger the teardown trap, undoing all of it). :5003 is normally
# owned by the menubar-managed console (KeepAlive — it respawns when killed), so
# don't fight it: run alongside on another port, or wire the env for it.
if [[ "$START_DEV" -eq 1 ]] && lsof -nP -iTCP:"$DEV_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "error: port $DEV_PORT already in use (likely the menubar-managed console)." >&2
  echo "       choose one:" >&2
  echo "         • run alongside on another port:   $0 --instance $INSTANCE --with-hosts --port 5013" >&2
  echo "         • or wire sshuttle + .env.local for the menubar's server, then restart it from the menubar:" >&2
  echo "                                            $0 --instance $INSTANCE --with-hosts --no-dev" >&2
  exit 2
fi

# ── Load instance state ──────────────────────────────────────────────────────
set -a
# shellcheck disable=SC1091
source "$INST_DIR/.stack-state.env"
[[ -f "$INST_DIR/.objectstore.env" ]] && source "$INST_DIR/.objectstore.env"
set +a

remote_init  # populates REMOTE_SSH_TARGET / REMOTE_SSH_OPTS / REMOTE_KUBECONFIG

PRIV_IP="${PRIV_IP:-10.42.1.10}"
NODE_SUBNET="${PRIV_IP%.*}.0/24"

say() { printf '\033[1;36m[dev-console]\033[0m %s\n' "$*"; }

# ── 1. Fetch a working kubeconfig from the node (creds included) ──────────────
# `kubectl config view --raw` is allowlisted for artesca-os sudo and emits the
# full admin.conf with client cert/key. Its server is already https://<priv>:6443
# (cert valid for that IP) → reachable once sshuttle routes the node subnet.
KCFG="$INST_DIR/.dev-console.kubeconfig"
say "Fetching kubeconfig from node → $KCFG"
rsh "sudo -n kubectl --kubeconfig=/etc/kubernetes/admin.conf config view --raw -o yaml 2>/dev/null" \
  | grep -avE 'WARNING|authorized personnel|monitor|consent|criminal|law enforce|------' > "$KCFG"
grep -q "server: https://" "$KCFG" || { echo "error: kubeconfig fetch failed" >&2; exit 1; }
chmod 600 "$KCFG"

# ── 2. Discover cluster CIDRs + Kafka ClusterIP (generic per cluster) ─────────
say "Discovering cluster CIDRs + Kafka ClusterIP"
K="sudo -n kubectl --kubeconfig=/etc/kubernetes/admin.conf"
SVC_CIDR="$(rsh "$K -n kube-system get pod -l component=kube-apiserver -o jsonpath='{.items[0].spec.containers[0].command}' 2>/dev/null | tr ',' '\n' | grep -oE 'service-cluster-ip-range=[0-9./]+' | cut -d= -f2" 2>/dev/null | grep -oE '^[0-9.]+/[0-9]+' | head -1)"
SVC_CIDR="${SVC_CIDR:-10.96.0.0/12}"
POD_CIDR="$(rsh "$K -n kube-system get pod -l component=kube-controller-manager -o jsonpath='{.items[0].spec.containers[0].command}' 2>/dev/null | tr ',' '\n' | grep -oE 'cluster-cidr=[0-9./]+' | cut -d= -f2" 2>/dev/null | grep -oE '^[0-9.]+/[0-9]+' | head -1)"
POD_CIDR="${POD_CIDR:-10.233.0.0/16}"
VSS_NS="${STACK_ID:+vss-${SCALITY_BP_PROFILE:-alerts}}"; VSS_NS="${VSS_NS:-vss-alerts}"
KAFKA_IP="$(rsh "$K -n $VSS_NS get svc kafka-kafka -o jsonpath='{.spec.clusterIP}' 2>/dev/null" 2>/dev/null | grep -oE '^[0-9.]+' | head -1)"

say "  node-subnet=$NODE_SUBNET  pod=$POD_CIDR  svc=$SVC_CIDR  ns=$VSS_NS  kafka=${KAFKA_IP:-?}"

# ── 3. Write console/.env.local ───────────────────────────────────────────────
ENVF="$REPO_ROOT/console/.env.local"
say "Writing $ENVF"
{
  echo "# Generated by scripts/dev-console.sh for instance '$INSTANCE' — do not commit."
  echo "CONSOLE_DISABLE_AUTH=true"
  echo "KUBECONFIG=$KCFG"
  echo "VSS_NAMESPACE=$VSS_NS"
  # S3 — reach ARTESCA over its public vhost (works without sshuttle).
  if [[ -n "${OBJECTSTORE_ENDPOINT:-}" ]]; then
    echo "OBJECTSTORE_ENDPOINT=https://s3.artesca.isv-lab.local"
    echo "OBJECTSTORE_ENDPOINT_IP=${PUB_IP}"
    echo "OBJECTSTORE_TLS_INSECURE=true"
    echo "OBJECTSTORE_REGION=${OBJECTSTORE_REGION:-us-east-1}"
    echo "OBJECTSTORE_BUCKET=${OBJECTSTORE_BUCKET:-nvidia-vss-recordings}"
    [[ -n "${OBJECTSTORE_ACCESS_KEY_ID:-}" ]] && echo "OBJECTSTORE_ACCESS_KEY_ID=${OBJECTSTORE_ACCESS_KEY_ID}"
    [[ -n "${OBJECTSTORE_SECRET_ACCESS_KEY:-}" ]] && echo "OBJECTSTORE_SECRET_ACCESS_KEY=${OBJECTSTORE_SECRET_ACCESS_KEY}"
  fi
  # Kafka — bootstrap at the ClusterIP (routable via sshuttle); the broker still
  # advertises `kafka-kafka`, which needs the /etc/hosts alias (--with-hosts).
  [[ -n "${KAFKA_IP:-}" ]] && echo "KAFKA_BROKERS=kafka-kafka:9092"
} > "$ENVF"

# ── 4. Optional /etc/hosts alias for Kafka's advertised name ──────────────────
HOSTS_LINE="${KAFKA_IP:-} kafka-kafka  # dev-console:$INSTANCE"
cleanup_hosts() { sudo sed -i '' "/# dev-console:$INSTANCE\$/d" /etc/hosts 2>/dev/null || true; }
if [[ "$WITH_HOSTS" -eq 1 && -n "${KAFKA_IP:-}" ]]; then
  say "Adding /etc/hosts alias: $HOSTS_LINE (sudo)"
  cleanup_hosts
  echo "$HOSTS_LINE" | sudo tee -a /etc/hosts >/dev/null
  trap cleanup_hosts EXIT
fi

# ── 5. Start sshuttle (routes the cluster network through the node) ───────────
# Prime the sudo timestamp NOW, interactively, BEFORE launching sshuttle.
# sshuttle --daemon forks a privileged firewall helper via sudo; in daemon mode
# its password prompt gets orphaned (the script moves on to the dev server) and
# the pf rules are never installed → no routing. A warm sudo cache on this tty
# lets the helper's sudo run without prompting.
say "Priming sudo (sshuttle needs root to program routes) — enter your password if asked"
sudo -v

say "Starting sshuttle → $REMOTE_SSH_TARGET ($NODE_SUBNET $POD_CIDR $SVC_CIDR)"
# Force ControlMaster off for sshuttle's own SSH: REMOTE_SSH_OPTS enables
# connection multiplexing (ControlMaster=auto/ControlPath), and grafting
# sshuttle's long-lived channel onto a shared master derails it — the same
# footgun that broke `ssh -L` tunnels (see lib-kubectl.sh). First value wins.
SSH_CMD="ssh -o ControlMaster=no -o ControlPath=none ${REMOTE_SSH_OPTS[*]}"
sshuttle --ssh-cmd "$SSH_CMD" -r "$REMOTE_SSH_TARGET" "$NODE_SUBNET" "$POD_CIDR" "$SVC_CIDR" --daemon --pidfile "$INST_DIR/.dev-console-sshuttle.pid"
cleanup_sshuttle() {
  [[ -f "$INST_DIR/.dev-console-sshuttle.pid" ]] && sudo kill "$(cat "$INST_DIR/.dev-console-sshuttle.pid")" 2>/dev/null || true
}
trap 'cleanup_sshuttle; cleanup_hosts' EXIT

# Verify the cluster network is actually routable before starting the server —
# don't optimistically claim "up" (the failure mode above looked up but wasn't).
say "Waiting for the cluster route (apiserver $PRIV_IP:6443)…"
ROUTE_OK=0
for _i in $(seq 1 12); do
  if nc -z -G 2 "$PRIV_IP" 6443 2>/dev/null; then ROUTE_OK=1; break; fi
  sleep 1
done
if [[ "$ROUTE_OK" -eq 1 ]]; then
  say "  ✓ cluster network reachable via sshuttle"
else
  echo "error: sshuttle did not establish routing ($PRIV_IP:6443 unreachable)." >&2
  echo "       check the sudo prompt was answered; see: pgrep -fl sshuttle" >&2
  exit 1
fi

# ── 6. Notes + start the dev server ───────────────────────────────────────────
cat <<NOTE

  ✓ kubeconfig + sshuttle up. K8s API, Kafka, VST, redis reachable by cluster address.
  ✓ S3 via the public ARTESCA vhost.
  ⚠ Kafka needs the advertised-name alias: $([[ "$WITH_HOSTS" -eq 1 ]] && echo "added" || echo "re-run with --with-hosts, or add to /etc/hosts: $HOSTS_LINE")
  ⚠ Prometheus stays unreachable (ARTESCA fronts it with auth; the console sends no creds).
  ⚠ camera-sim is a separate instance, not in this cluster.

NOTE

if [[ "$START_DEV" -eq 1 ]]; then
  say "Starting console dev server on http://localhost:$DEV_PORT (Ctrl-C stops it + tears down sshuttle/hosts)"
  cd "$REPO_ROOT/console"
  npx next dev --port "$DEV_PORT"
else
  say "Setup complete (--no-dev): sshuttle + .env.local + hosts are in place."
  say "Restart the menubar-managed console (:5003) so it reloads .env.local."
  say "Keeping sshuttle up — press Enter to tear it down."
  read -r _
fi
