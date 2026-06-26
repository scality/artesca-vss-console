#!/usr/bin/env bash
# pyramid-console-tunnel.sh — keep http://localhost:8800 pointed at the Pyramid
# in-cluster operator console across reboots and network drops.
#
# Why a two-stage tunnel: the Pyramid host is a DMZ bare-metal node reached over
# SSH on :15022. The console is a ClusterIP service (no NodePort), reachable only
# through the cluster — so a plain `ssh -L` to a node port can't hit it. Instead:
#   1. ssh -L 16443:<apiserver> — the apiserver is the one forward target that
#      matters; sshd forwarding was re-enabled on this host (see bootstrap-node-env
#      Step 5).
#   2. kubectl port-forward svc/console 8800:8800 — rides the apiserver tunnel and
#      resolves the console pod dynamically, so a console redeploy / ClusterIP
#      change is transparent (unlike a raw ssh -L to a fixed ClusterIP).
#
# Managed by LaunchAgent com.scality.isv-labs.pyramid-console-tunnel
# (RunAtLoad + KeepAlive). The script blocks on kubectl port-forward and exits
# when it (or the underlying tunnel) dies, so launchd respawns the whole chain.
#
# Manual use: scripts/pyramid-console-tunnel.sh   (Ctrl-C tears both down)
set -uo pipefail

INSTANCE="pyramid-showroom"
SSH_KEY="$HOME/.ssh/pyramid-showroom"
SSH_HOST="62.153.205.53"
SSH_PORT="15022"
SSH_USER="artesca-os"
PRIV_IP="10.172.0.15"             # apiserver bind IP on the node
APISERVER_LPORT="16443"
CONSOLE_LPORT="8800"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KCFG="$REPO_ROOT/scripts/instances/$INSTANCE/.dev-console.kubeconfig"
CTRL="/tmp/pyramid-console-tunnel-apiserver.ctl"

# launchd gives a minimal PATH; make sure ssh/kubectl/nc resolve.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

[[ -f "$SSH_KEY" ]] || { log "FATAL: ssh key $SSH_KEY missing"; exit 1; }
[[ -f "$KCFG"   ]] || { log "FATAL: kubeconfig $KCFG missing"; exit 1; }
command -v kubectl >/dev/null || { log "FATAL: kubectl not on PATH"; exit 1; }

cleanup() {
  ssh -O exit -o ControlPath="$CTRL" -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Clear any stale apiserver master from a prior run (frees :16443 + the socket).
ssh -O exit -o ControlPath="$CTRL" -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" 2>/dev/null || true
# Free a stale local :8800 / :16443 squatter (e.g. a manual port-forward).
for p in "$CONSOLE_LPORT" "$APISERVER_LPORT"; do
  lsof -ti "tcp:$p" -sTCP:LISTEN 2>/dev/null | xargs -r kill 2>/dev/null || true
done

log "opening apiserver tunnel :$APISERVER_LPORT → $PRIV_IP:6443 via $SSH_USER@$SSH_HOST:$SSH_PORT"
ssh -i "$SSH_KEY" -p "$SSH_PORT" \
    -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -o ConnectTimeout=15 -o ControlMaster=yes -o ControlPath="$CTRL" -o LogLevel=ERROR \
    -fN -L "$APISERVER_LPORT:$PRIV_IP:6443" "$SSH_USER@$SSH_HOST" \
  || { log "FATAL: apiserver ssh tunnel failed to start"; exit 1; }

# Wait for the forward to accept connections.
ok=0
for _ in $(seq 1 15); do nc -z 127.0.0.1 "$APISERVER_LPORT" 2>/dev/null && { ok=1; break; }; sleep 1; done
[[ "$ok" -eq 1 ]] || { log "FATAL: :$APISERVER_LPORT never came up"; exit 1; }
log "apiserver tunnel up; starting kubectl port-forward :$CONSOLE_LPORT → svc/console"

# Foreground: blocks until the port-forward (or the tunnel under it) dies, then
# the script exits and launchd KeepAlive respawns the whole chain.
kubectl --kubeconfig="$KCFG" -n console port-forward --address 127.0.0.1 \
        svc/console "$CONSOLE_LPORT:8800"
rc=$?
log "kubectl port-forward exited (rc=$rc) — exiting so launchd respawns"
exit "$rc"
