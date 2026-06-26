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

# Pin the Pyramid host key to a managed known_hosts file rather than /dev/null.
# accept-new pins on first connect and then VERIFIES every subsequent one, so a
# man-in-the-middle that substitutes the host key (this tunnel carries the
# in-cluster admin console over a public DMZ SSH port) is detected, not blindly
# accepted. The DMZ node has a fixed IP, so pinning is practical here.
#
# Reinstall self-heal: a from-scratch reinstall regenerates the host key, which
# accept-new (correctly) refuses with "REMOTE HOST IDENTIFICATION HAS CHANGED"
# until the old pin is cleared. After verifying the new fingerprint out of band,
# re-pin deliberately by running once with PYRAMID_TUNNEL_REPIN_HOSTKEY=1
# (clears the old entry so the next connect re-pins). Default is strict.
KNOWN_HOSTS="$HOME/.ssh/known_hosts.pyramid"
SSH_COMMON=(-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$KNOWN_HOSTS"
            -o ConnectTimeout=15 -o LogLevel=ERROR)

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

# Operator-confirmed reinstall: drop the stale pin so accept-new re-pins to the
# reinstalled host. Gated behind an explicit env so a host-key change is never
# trusted silently — set it only after verifying the new fingerprint out of band.
if [[ "${PYRAMID_TUNNEL_REPIN_HOSTKEY:-0}" == "1" && -f "$KNOWN_HOSTS" ]]; then
  ssh-keygen -R "[$SSH_HOST]:$SSH_PORT" -f "$KNOWN_HOSTS" >/dev/null 2>&1 || true
  log "PYRAMID_TUNNEL_REPIN_HOSTKEY=1 — cleared pinned host key for [$SSH_HOST]:$SSH_PORT; will re-pin on next connect"
fi

[[ -f "$SSH_KEY" ]] || { log "FATAL: ssh key $SSH_KEY missing"; exit 1; }
command -v kubectl >/dev/null || { log "FATAL: kubectl not on PATH"; exit 1; }
mkdir -p "$(dirname "$KCFG")"

# Refetch the node's kubeconfig each start. A from-scratch cluster reinstall mints
# a new CA + client cert, so the cached kubeconfig 401s until refreshed. This rides
# the SSH *exec* channel (kubectl on the node is sudo-allowlisted), so it works even
# before TCP forwarding is sorted. Best-effort: a transient SSH failure leaves the
# existing kubeconfig untouched rather than wiping a working one.
refresh_kubeconfig() {
  local tmp="${KCFG}.tmp.$$"
  if ssh -i "$SSH_KEY" -p "$SSH_PORT" "${SSH_COMMON[@]}" "$SSH_USER@$SSH_HOST" \
        "sudo -n kubectl --kubeconfig=/etc/kubernetes/admin.conf config view --raw -o yaml 2>/dev/null" \
        2>/dev/null \
      | grep -avE 'WARNING|authorized|monitor|consent|criminal|law enforce|officials|personnel|------|administratively' \
      > "$tmp" && grep -q 'server: https://' "$tmp"; then
    sed -i '' -E \
      -e "s#server: https://[0-9.]+:6443#server: https://127.0.0.1:${APISERVER_LPORT}#" \
      -e 's#certificate-authority-data:.*#insecure-skip-tls-verify: true#' \
      "$tmp"
    chmod 600 "$tmp" && mv -f "$tmp" "$KCFG" && log "kubeconfig refreshed from node"
  else
    rm -f "$tmp"
    log "kubeconfig refetch failed (node/cluster not ready?) — keeping existing $KCFG"
  fi
}
refresh_kubeconfig
[[ -f "$KCFG" ]] || { log "FATAL: no kubeconfig at $KCFG and refetch failed — node unreachable?"; exit 1; }

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
ssh -i "$SSH_KEY" -p "$SSH_PORT" "${SSH_COMMON[@]}" \
    -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -o ControlMaster=yes -o ControlPath="$CTRL" \
    -fN -L "$APISERVER_LPORT:$PRIV_IP:6443" "$SSH_USER@$SSH_HOST" \
  || { log "FATAL: apiserver ssh tunnel failed to start (if the node was reinstalled, the host key changed — verify the new fingerprint, then re-run once with PYRAMID_TUNNEL_REPIN_HOSTKEY=1)"; exit 1; }

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
