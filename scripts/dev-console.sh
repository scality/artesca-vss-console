#!/usr/bin/env bash
# dev-console.sh — run the in-cluster console LOCALLY against a live instance's
# cluster, using SSH local port-forwards (ssh -L). Unlike sshuttle this needs NO
# laptop sudo for the tunnels (ssh -L is unprivileged) — only the optional Kafka
# /etc/hosts alias touches sudo (one line). The K8s tunnel is the same one that
# lists pods reliably; we forward each service the console needs.
#
# Usage:
#   scripts/dev-console.sh --instance <name> [--port N] [--no-dev] [--with-hosts]
#
#   --instance <name>   instance under scripts/instances/<name>/ (required)
#   --port <N>          dev-server port (default 5003). Use another (e.g. 5013)
#                       to run ALONGSIDE the menubar-managed console on :5003.
#   --no-dev            set up tunnels + .env.local but don't start a server.
#   --with-hosts        add the Kafka advertised-name alias to /etc/hosts
#                       (127.0.0.1 kafka-kafka — sudo; removed on exit). Without
#                       it Kafka stays "unreachable" (see the printed note).
#
# Forwarded:  :16443 → apiserver(:6443) · :9092 → kafka · :19090 → metalk8s-monitoring
# Prometheus (GPU/DCGM metrics). S3 goes over the public ARTESCA vhost (no tunnel).
# camera-sim host is auto-discovered (reaching its :9997 also needs the laptop /32
# on the camera-sim SG).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
# shellcheck source=lib-remote.sh
source "$HERE/lib-remote.sh"

INSTANCE=""; START_DEV=1; WITH_HOSTS=0; DEV_PORT=5003
while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance) INSTANCE="$2"; shift 2 ;;
    --instance=*) INSTANCE="${1#--instance=}"; shift ;;
    --no-dev) START_DEV=0; shift ;;
    --with-hosts) WITH_HOSTS=1; shift ;;
    --port) DEV_PORT="$2"; shift 2 ;;
    --port=*) DEV_PORT="${1#--port=}"; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$INSTANCE" ]] || { echo "error: --instance <name> required" >&2; exit 2; }
INST_DIR="$REPO_ROOT/scripts/instances/$INSTANCE"
[[ -d "$INST_DIR" ]] || { echo "error: $INST_DIR not found" >&2; exit 2; }

say() { printf '\033[1;36m[dev-console]\033[0m %s\n' "$*"; }
# ok/warn/die are required by lib-sg-bridge.sh (sourced for camera-sim SG auth).
ok()   { printf '\033[1;32m OK\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }

# Local forward ports.
K8S_PORT=16443
KAFKA_PORT=9092
PROM_PORT=19090
for p in "$DEV_PORT" "$K8S_PORT" "$KAFKA_PORT" "$PROM_PORT"; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    [[ "$p" == "$DEV_PORT" && "$START_DEV" -eq 0 ]] && continue
    echo "error: port $p already in use." >&2
    [[ "$p" == "$DEV_PORT" ]] && echo "       :5003 is normally the menubar console — run with --port 5013 to run alongside." >&2
    echo "       free it:  lsof -ti :$p | xargs kill" >&2
    exit 2
  fi
done

# ── Load instance state ──────────────────────────────────────────────────────
set -a
# shellcheck disable=SC1091
source "$INST_DIR/.stack-state.env"
[[ -f "$INST_DIR/.objectstore.env" ]] && source "$INST_DIR/.objectstore.env"
set +a
remote_init
PRIV_IP="${PRIV_IP:-10.42.1.10}"

# ── 1. Fetch + rewrite kubeconfig for the local tunnel ────────────────────────
KCFG="$INST_DIR/.dev-console.kubeconfig"
say "Fetching kubeconfig from node → $KCFG"
rsh "sudo -n kubectl --kubeconfig=/etc/kubernetes/admin.conf config view --raw -o yaml 2>/dev/null" \
  | grep -avE 'WARNING|authorized|monitor|consent|criminal|law enforce|officials|personnel|------' > "$KCFG"
grep -q "server: https://" "$KCFG" || { echo "error: kubeconfig fetch failed" >&2; exit 1; }
# Point at the local tunnel; the apiserver cert is for $PRIV_IP, not 127.0.0.1,
# so swap the CA for insecure-skip-tls-verify (lab-only).
sed -i '' -E \
  -e "s#server: https://[0-9.]+:6443#server: https://127.0.0.1:${K8S_PORT}#" \
  -e 's#certificate-authority-data:.*#insecure-skip-tls-verify: true#' \
  "$KCFG"
chmod 600 "$KCFG"

# ── 2. Discover Kafka ClusterIP + VSS namespace ───────────────────────────────
K="sudo -n kubectl --kubeconfig=/etc/kubernetes/admin.conf"
VSS_NS="${STACK_ID:+vss-${SCALITY_BP_PROFILE:-alerts}}"; VSS_NS="${VSS_NS:-vss-alerts}"
KAFKA_IP="$(rsh "$K -n $VSS_NS get svc kafka-kafka -o jsonpath='{.spec.clusterIP}' 2>/dev/null" 2>/dev/null | grep -oE '^[0-9.]+' | head -1)"
# Prometheus lives in metalk8s-monitoring (the instance that scrapes DCGM/GPU —
# artesca-monitoring's does NOT). Its svc is headless, so forward a prometheus
# POD IP (re-discovered each run, like KAFKA_IP).
PROM_IP="$(rsh "$K -n metalk8s-monitoring get pod -l app.kubernetes.io/name=prometheus -o jsonpath='{.items[0].status.podIP}' 2>/dev/null" 2>/dev/null | grep -oE '^[0-9.]+' | head -1)"
say "ns=$VSS_NS  kafka=${KAFKA_IP:-?}  prometheus=${PROM_IP:-?}  (K8s→:$K8S_PORT, Kafka→:$KAFKA_PORT, Prom→:$PROM_PORT)"

# ── 2b. Discover camera-sim host + auto-authorize this laptop on its SG :9997 ──
# The camera-sim is a separate instance; the console probes its mediamtx REST API
# at CAMERA_SIM_HOST:9997. Explicit CAMERA_SIM_HOST env wins; otherwise, when
# exactly one camera-sim instance dir carries a PUB_IP, use it (CAMSIM_STATE
# remembers which dir, so we can read its SG params for the auto-auth below).
CAMSIM_HOST="${CAMERA_SIM_HOST:-}"
CAMSIM_STATE=""
if [[ -z "$CAMSIM_HOST" ]]; then
  _camsim_states=()
  for _f in "$REPO_ROOT"/scripts/camera-sim-instances/*/.camera-sim-state.env; do
    [[ -f "$_f" ]] || continue
    grep -qE '^PUB_IP=.+' "$_f" 2>/dev/null && _camsim_states+=("$_f")
  done
  if [[ "${#_camsim_states[@]}" -eq 1 ]]; then
    CAMSIM_STATE="${_camsim_states[0]}"
    CAMSIM_HOST="$(grep -E '^PUB_IP=' "$CAMSIM_STATE" | tail -1 | cut -d= -f2)"
    say "camera-sim host → $CAMSIM_HOST (auto-discovered)"
  elif [[ "${#_camsim_states[@]}" -gt 1 ]]; then
    say "⚠ ${#_camsim_states[@]} camera-sim instances found — set CAMERA_SIM_HOST=<ip> to pick one; leaving unset"
  fi
fi

# Auto-authorize this laptop's current /32 on the camera-sim SG :9997 so the
# console's mediamtx probe reaches the API. Self-healing across laptop-IP drift
# via lib-sg-bridge (revokes a stale laptop rule, re-authorizes the current IP);
# idempotent when the IP hasn't changed. Runs only when the camera-sim dir was
# auto-discovered (we need its SG params). Non-fatal — a failure (e.g. expired
# SSO) just leaves camera-sim unreachable, surfaced as a warning.
if [[ -n "$CAMSIM_HOST" && -n "$CAMSIM_STATE" ]]; then
  _myip="$(curl -fsS -m 8 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ "$_myip" =~ ^[0-9.]+$ ]]; then
    # shellcheck disable=SC1090,SC1091
    ( set -a; source "$CAMSIM_STATE"; set +a
      SG_OWNER_AWS_PROFILE="$AWS_PROFILE" SG_OWNER_AWS_REGION="$AWS_REGION" \
      SG_OWNER_SG_ID="$SG_ID" SG_SOURCE_PUB_IP="$_myip" SG_PORT=9997 \
      SG_DESCRIPTION_TAG="laptop-local-console-mediamtx-api" \
      SG_RULE_FILE="$INST_DIR/.camerasim-sg-rule-laptop-9997.env" \
      SG_RULE_GENERATED_BY="dev-console.sh"
      source "$HERE/lib-sg-bridge.sh"
      sg_bridge_authorize ) \
      || say "⚠ camera-sim SG :9997 auth failed for $_myip/32 — refresh SSO (aws sso login) or open it manually; camera-sim may show unreachable"
  else
    say "⚠ couldn't resolve laptop public IP — skipping camera-sim SG :9997 auth (camera-sim may show unreachable)"
  fi
fi

# ── 3. Write console/.env.local ───────────────────────────────────────────────
ENVF="$REPO_ROOT/console/.env.local"
say "Writing $ENVF"
{
  echo "# Generated by scripts/dev-console.sh for '$INSTANCE' — do not commit."
  echo "CONSOLE_DISABLE_AUTH=true"
  echo "KUBECONFIG=$KCFG"
  echo "VSS_NAMESPACE=$VSS_NS"
  if [[ -n "${OBJECTSTORE_ENDPOINT:-}" ]]; then
    # `.objectstore.env` was sourced with `set -a`, so OBJECTSTORE_ENDPOINT is
    # exported as the bare node IP — and a pre-set env var shadows .env.local in
    # Next.js. Re-export the vhost FQDN (IP-pinned, demo-cert-insecure) so the
    # spawned dev server inherits the value that actually routes to ARTESCA S3.
    export OBJECTSTORE_ENDPOINT="https://s3.artesca.isv-lab.local"
    export OBJECTSTORE_ENDPOINT_IP="${PUB_IP}"
    export OBJECTSTORE_TLS_INSECURE="true"
    echo "OBJECTSTORE_ENDPOINT=${OBJECTSTORE_ENDPOINT}"
    echo "OBJECTSTORE_ENDPOINT_IP=${OBJECTSTORE_ENDPOINT_IP}"
    echo "OBJECTSTORE_TLS_INSECURE=${OBJECTSTORE_TLS_INSECURE}"
    echo "OBJECTSTORE_REGION=${OBJECTSTORE_REGION:-us-east-1}"
    echo "OBJECTSTORE_BUCKET=${OBJECTSTORE_BUCKET:-nvidia-vss-recordings}"
    [[ -n "${OBJECTSTORE_ACCESS_KEY_ID:-}" ]] && echo "OBJECTSTORE_ACCESS_KEY_ID=${OBJECTSTORE_ACCESS_KEY_ID}"
    [[ -n "${OBJECTSTORE_SECRET_ACCESS_KEY:-}" ]] && echo "OBJECTSTORE_SECRET_ACCESS_KEY=${OBJECTSTORE_SECRET_ACCESS_KEY}"
  fi
  # Kafka advertises `kafka-kafka:9092`; with the hosts alias that resolves to
  # 127.0.0.1 → the local forward. Bootstrap uses the same name for consistency.
  [[ -n "${KAFKA_IP:-}" ]] && echo "KAFKA_BROKERS=kafka-kafka:${KAFKA_PORT}"
  [[ -n "${CAMSIM_HOST:-}" ]] && echo "CAMERA_SIM_HOST=$CAMSIM_HOST"
  [[ -n "${PROM_IP:-}" ]] && echo "PROMETHEUS_URL=http://127.0.0.1:${PROM_PORT}"
  # Grafana SSO login surfaced on the console Overview. Grafana sits behind
  # ARTESCA's :8443 Keycloak SSO, so the login is the ARTESCA admin. Pull it from
  # the node's initial-admin secret so the local console shows the creds in clear
  # (lab/demo convenience — the in-cluster ConfigMap leaves this unset).
  GRAFANA_PW="$(rsh "sudo -n kubectl --kubeconfig=/etc/kubernetes/admin.conf -n artesca-auth get secret artesca-kc-initial-admin -o jsonpath='{.data.password}' 2>/dev/null | base64 -d" 2>/dev/null || true)"
  [[ -n "$GRAFANA_PW" ]] && echo "GRAFANA_PASSWORD=$GRAFANA_PW"
} > "$ENVF"

# ── 4. /etc/hosts alias for Kafka. Redpanda advertises itself as `kafka-kafka:9092`,
#       so the client must resolve that name to the local forward (bootstrapping on
#       127.0.0.1 alone isn't enough — the broker redirects to its advertised name).
#       The alias is PERSISTENT + idempotent: laid down once (needs sudo), then reused
#       by no-sudo runs — notably the menubar-managed console, which can't sudo per
#       launch. NOT removed on exit, so a single `--with-hosts` run enables Kafka for
#       good (a 127.0.0.1 alias is harmless when no tunnel is up — just conn-refused).
HOSTS_OK=0
if grep -qE '^[0-9.]+[[:space:]]+kafka-kafka([[:space:]]|#|$)' /etc/hosts 2>/dev/null; then
  HOSTS_OK=1
elif [[ "$WITH_HOSTS" -eq 1 && -n "${KAFKA_IP:-}" ]]; then
  say "Adding persistent /etc/hosts alias: 127.0.0.1 kafka-kafka (sudo, one-time)"
  echo "127.0.0.1 kafka-kafka  # dev-console (persistent — Kafka advertised name)" \
    | sudo tee -a /etc/hosts >/dev/null && HOSTS_OK=1
fi

# ── 5. Open the SSH local forwards (no sudo) ──────────────────────────────────
# ControlMaster off so the forward doesn't graft onto a shared multiplex master
# (the footgun that broke -L tunnels before — see lib-kubectl.sh).
FWD=( -L "${K8S_PORT}:${PRIV_IP}:6443" )
[[ -n "${KAFKA_IP:-}" ]] && FWD+=( -L "${KAFKA_PORT}:${KAFKA_IP}:9092" )
[[ -n "${PROM_IP:-}" ]] && FWD+=( -L "${PROM_PORT}:${PROM_IP}:9090" )
say "Opening SSH forwards → $REMOTE_SSH_TARGET"
# LogLevel=QUIET suppresses the node's pre-auth login Banner (the long
# "authorized users only" block) that otherwise floods the menubar logs.
ssh -o ControlMaster=no -o ControlPath=none -o ExitOnForwardFailure=yes -o LogLevel=QUIET \
  "${REMOTE_SSH_OPTS[@]}" "${FWD[@]}" -N "$REMOTE_SSH_TARGET" &
SSH_PID=$!
trap 'kill "$SSH_PID" 2>/dev/null || true' EXIT

say "Waiting for the K8s forward (127.0.0.1:$K8S_PORT)…"
OK=0
for _i in $(seq 1 15); do
  if nc -z 127.0.0.1 "$K8S_PORT" 2>/dev/null; then OK=1; break; fi
  kill -0 "$SSH_PID" 2>/dev/null || { echo "error: ssh forward exited (check the key / node)" >&2; exit 1; }
  sleep 1
done
[[ "$OK" -eq 1 ]] || { echo "error: K8s forward never came up on 127.0.0.1:$K8S_PORT" >&2; exit 1; }
say "  ✓ K8s API reachable via the tunnel"

# ── 6. Notes + start the dev server ───────────────────────────────────────────
cat <<NOTE

  ✓ K8s API + S3 wired. Kafka: $([[ "$HOSTS_OK" -eq 1 ]] && echo "kafka-kafka alias present → reachable" || echo "unreachable — run once with --with-hosts to add the persistent 127.0.0.1 kafka-kafka alias (sudo)")
  ⚠ Prometheus stays unreachable (ARTESCA auth; console sends no creds).
  $([[ -n "${CAMSIM_HOST:-}" ]] \
    && echo "✓ camera-sim → $CAMSIM_HOST:9997 (this laptop's /32 is auto-authorized on the camera-sim SG :9997, self-healing on IP drift)" \
    || echo "⚠ camera-sim is a separate instance, not in this cluster — set CAMERA_SIM_HOST=<ip> to wire it.")

NOTE

# If the console is ALREADY serving on its own port, reuse it rather than starting
# a second `next dev` (which would fail on the per-directory .next/dev lock).
# Detect by the console's OWN port — NOT `pgrep next dev`, which also matches the
# deployer's `next dev --port 5002` in a different directory and caused a false
# "already running" that skipped the server start and left :$DEV_PORT down.
if [[ "$START_DEV" -eq 1 ]] && nc -z 127.0.0.1 "$DEV_PORT" 2>/dev/null; then
  say "A console dev server is already serving on :$DEV_PORT — reusing it (not starting a second)."
  START_DEV=0
fi

if [[ "$START_DEV" -eq 1 ]]; then
  say "Starting console dev server on http://localhost:$DEV_PORT (Ctrl-C stops it + tears down tunnels)"
  cd "$REPO_ROOT/console"
  npx next dev --port "$DEV_PORT"
else
  echo ""
  say "Tunnels + .env.local + hosts are in place and HELD by this process."
  say "→ Restart the menubar-managed console so it reloads .env.local:"
  say "    Scality menubar → (console server) → Restart"
  say "→ Then open  http://localhost:5003  — K8s / Kafka / S3 should be green."
  say "Keep this process alive (the tunnels live here). Ctrl-C / stopping it tears them down."
  # wait (not `read`) so it also holds when launched without a TTY (e.g. the menubar).
  wait "$SSH_PID"
fi
