#!/usr/bin/env bash
# Smoke-test the Demo Console deployment.
#
# Checks:
#   1. Deployment console in ns:console has readyReplicas >= 1
#   2. PVC console-data is Bound
#   3. ServiceAccount console-sa exists
#   4. /api/health/self returns {"status":"ok"} (via public :8800)
#   5. Recording canary — every online camera actually records (VST storage
#      returns a recent clip), not just shows the REC flag
#
# Env:
#   NODE_IP   — public IP for the HTTP health check (default: read from
#               scripts/.stack-state.env PUBLIC_IP; falls back to skip curl)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

PASS=0
FAIL=0

check_pass() { echo "  PASS  $*"; PASS=$(( PASS + 1 )); }
check_fail() { echo "  FAIL  $*"; FAIL=$(( FAIL + 1 )); }

# ---------------------------------------------------------------------------
# 1. Deployment ready
# ---------------------------------------------------------------------------

READY=$(kubectl -n console get deployment console \
  -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
if [ "${READY:-0}" -ge 1 ]; then
  check_pass "deployment console readyReplicas=${READY}"
else
  check_fail "deployment console not ready (readyReplicas=${READY:-0})"
  echo "        Hint: kubectl -n console describe deployment console"
  echo "              kubectl -n console logs deploy/console --tail=50"
fi

# ---------------------------------------------------------------------------
# 2. PVC Bound
# ---------------------------------------------------------------------------

PVC_PHASE=$(kubectl -n console get pvc console-data \
  -o jsonpath='{.status.phase}' 2>/dev/null || echo "MISSING")
if [ "$PVC_PHASE" = "Bound" ]; then
  check_pass "pvc console-data phase=Bound"
else
  check_fail "pvc console-data phase=${PVC_PHASE}"
  echo "        Hint: kubectl -n console describe pvc console-data"
  echo "              kubectl get storageclass"
fi

# ---------------------------------------------------------------------------
# 3. ServiceAccount exists
# ---------------------------------------------------------------------------

if kubectl -n console get sa console-sa >/dev/null 2>&1; then
  check_pass "serviceaccount console-sa exists"
else
  check_fail "serviceaccount console-sa missing"
  echo "        Hint: kubectl apply -k k8s/console"
fi

# ---------------------------------------------------------------------------
# 4. HTTP health check
# ---------------------------------------------------------------------------

if [ -n "$NODE_IP" ]; then
  HEALTH_URL="http://${NODE_IP}:8800/api/health/self"
  HTTP_BODY=$(curl -fsS --max-time 10 "$HEALTH_URL" 2>/dev/null || true)
  if echo "$HTTP_BODY" | grep -q '"status":"ok"'; then
    check_pass "GET /api/health/self -> ok"
  else
    check_fail "GET $HEALTH_URL did not return {\"status\":\"ok\"} (got: ${HTTP_BODY:-(empty)})"
    echo "        Hint: check SG allows :8800 from this IP; check console pod logs"
  fi
else
  echo "  SKIP  /api/health/self — NODE_IP not set and .stack-state.env not found"
fi

# ---------------------------------------------------------------------------
# 5. Recording canary — every online camera must ACTUALLY be recording
# ---------------------------------------------------------------------------
# Ground truth, not the isTimelinePresent flag (which goes stale): ask VST
# storage for a recent finalized window per camera. 200 = recording, 404 = not.
# Probes run via `kubectl exec` in the console pod (the only thing that can
# reach the in-cluster VST services); no console auth needed.

CONSOLE_POD=$(kubectl -n console get pod -l app=console \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
if [ -z "$CONSOLE_POD" ]; then
  echo "  SKIP  recording canary — console pod not found"
elif ! command -v python3 >/dev/null 2>&1; then
  echo "  SKIP  recording canary — python3 not available to parse sensor list"
else
  VSS_NS=$(kubectl -n console exec "$CONSOLE_POD" -- sh -c 'printenv VSS_NAMESPACE' 2>/dev/null || echo "")
  VSS_NS="${VSS_NS:-vss-base}"
  LIST_URL="http://vss-vios-sensor.${VSS_NS}.svc.cluster.local:30000/api/v1/sensor/list"
  STOR_URL="http://vss-vios-ingress.${VSS_NS}.svc.cluster.local:30888/vst/api/v1/storage/file"
  SENSORS_JSON=$(kubectl -n console exec "$CONSOLE_POD" -- curl -s --max-time 8 "$LIST_URL" 2>/dev/null || echo "")
  # name<TAB>streamId for each online sensor
  ONLINE_MAP=$(printf '%s' "$SENSORS_JSON" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
L = d if isinstance(d, list) else (d.get("sensors") or d.get("data") or [])
for s in L:
    if s.get("state") == "online" and s.get("name") and s.get("sensorId"):
        print(s["name"] + "\t" + s["sensorId"])
' 2>/dev/null || echo "")
  WINDOW=$(python3 -c '
import datetime
n = datetime.datetime.utcnow()
print((n - datetime.timedelta(seconds=23)).strftime("%Y-%m-%dT%H:%M:%SZ"),
      (n - datetime.timedelta(seconds=20)).strftime("%Y-%m-%dT%H:%M:%SZ"))')
  W_START="${WINDOW% *}"; W_END="${WINDOW#* }"
  if [ -z "$ONLINE_MAP" ]; then
    echo "  SKIP  recording canary — no online VST sensors (or list unreachable)"
  else
    NOT_REC=""; TOTAL=0; REC=0
    while IFS=$'\t' read -r cam_name cam_sid; do
      [ -z "$cam_sid" ] && continue
      TOTAL=$(( TOTAL + 1 ))
      CODE=$(kubectl -n console exec "$CONSOLE_POD" -- curl -s -o /dev/null -w '%{http_code}' \
        --max-time 12 "${STOR_URL}/${cam_sid}?startTime=${W_START}&endTime=${W_END}&container=mp4&disableAudio=true" \
        2>/dev/null || echo "000")
      if [ "$CODE" = "200" ]; then REC=$(( REC + 1 )); else NOT_REC="${NOT_REC} ${cam_name}(${CODE})"; fi
    done <<< "$ONLINE_MAP"
    if [ -z "$NOT_REC" ] && [ "$TOTAL" -gt 0 ]; then
      check_pass "recording canary — ${REC}/${TOTAL} online cameras recording"
    else
      check_fail "recording canary — NOT recording:${NOT_REC} (${REC}/${TOTAL} ok)"
      echo "        A camera can read REC in the UI yet not record. Recover per camera:"
      echo "        console Restart button, or delete-by-UUID + sensor/add(username:\"\") + proxy/stream/add."
      echo "        See scripts/stacks/nvidia-vss/CLAUDE.md → Camera registration."
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo
if [ "$FAIL" -eq 0 ]; then
  echo "Console smoke tests passed (${PASS} checks)."
  exit 0
else
  echo "Console smoke tests FAILED: ${FAIL} check(s) failed, ${PASS} passed."
  exit 1
fi
