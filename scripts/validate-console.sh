#!/usr/bin/env bash
# Smoke-test the Demo Console deployment.
#
# Checks:
#   1. Deployment console in ns:console has readyReplicas >= 1
#   2. PVC console-data is Bound
#   3. ServiceAccount console-sa exists
#   4. /api/health/self returns {"status":"ok"} (via public :8800)
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
