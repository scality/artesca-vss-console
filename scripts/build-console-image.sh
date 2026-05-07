#!/usr/bin/env bash
# build-console-image.sh — fully self-sufficient console image provisioning.
#
# Builds the console Docker image on the laptop (Docker Desktop required),
# ships it to the ARTESCA node as a tarball, and imports it into the
# cluster's containerd image store via a privileged K8s Job. The deploy
# side uses imagePullPolicy: Never so kubelet never tries GHCR.
#
# Rationale: ghcr.io/scality/isv-nvidia-nvidia-vss/console:latest is private, the
# EC2 instance has no imagePullSecret, and wiring one requires a GitHub PAT
# with read:packages scope — not grantable from the SSO role the laptop
# already has. Building locally and sideloading makes the deploy work with
# nothing but the existing SSO + SSH credentials.
#
# Idempotent: the image tag is derived from the current git state of the
# console/ tree. Reruns with no source changes short-circuit at the
# "already present" check on the node.
#
# Env:
#   REPO_ROOT      — repo checkout (default: parent of scripts/)
#   IMAGE_REPO     — override image repo (default: console.local)
#   FORCE_BUILD=1  — rebuild + re-import even if tag is already present
#                    (does NOT invalidate the buildx layer cache — unchanged
#                    layers still replay instantly)
#   BUILDX_CACHE_DIR — override buildx local cache path
#                    (default: ${TMPDIR:-/tmp}/nvidia-vss-console-buildx-cache)
#
# Buildx cache: persistent local layer cache at ${TMPDIR:-/tmp}/nvidia-vss-console-buildx-cache
# (outside the repo on purpose — it's gitignored build state). Reruns with no
# source change replay layers in seconds instead of re-running `npm ci` +
# `next build`. To bust it:  rm -rf "${TMPDIR:-/tmp}/nvidia-vss-console-buildx-cache"
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-paths.sh
source "$SCRIPT_DIR/lib-paths.sh" "$@"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

[[ -f "$VSS_STATE_FILE" ]] || {
  echo "ERROR: $VSS_STATE_FILE missing — run launch-stack.sh first" >&2
  exit 1
}
# shellcheck source=/dev/null
source "$VSS_STATE_FILE"
: "${PUB_IP:?PUB_IP missing from $VSS_STATE_FILE}"
KEY_NAME="${KEY_NAME:-isv-labs-ec2}"
KEY_PATH="${CAMERA_SIM_KEY_FILE:-$HOME/.ssh/${KEY_NAME}.pem}"
[[ -f "$KEY_PATH" ]] || { echo "ERROR: SSH key $KEY_PATH missing" >&2; exit 1; }
: "${SSH_USER:=artesca-os}"

# Image naming: use a repo-local name that is never fetched remotely. Tag
# from git so reruns skip unchanged builds.
IMAGE_REPO="${IMAGE_REPO:-console.local}"
# Last commit that touched console/. Fall back to a timestamp if not a git
# worktree (CI or tarball). Add "-dirty" if there are uncommitted changes
# under console/ so WIP builds don't collide with the previous tag.
TAG_HASH="$(git -C "$REPO_ROOT" log -1 --format=%h -- console/ 2>/dev/null || true)"
if [[ -z "$TAG_HASH" ]]; then
  TAG_HASH="$(date +%Y%m%d-%H%M%S)"
fi
if [[ -n "$(git -C "$REPO_ROOT" status --porcelain -- console/ 2>/dev/null)" ]]; then
  TAG_HASH="${TAG_HASH}-dirty"
fi
FULL_IMAGE="${IMAGE_REPO}:${TAG_HASH}"

SSH_OPTS=(-i "$KEY_PATH" -o StrictHostKeyChecking=accept-new -o BatchMode=yes)
KUBECTL_REMOTE="sudo -n kubectl --kubeconfig=/etc/kubernetes/admin.conf"

# ---------------------------------------------------------------------------
# Short-circuit: is the tag already in the cluster's containerd cache?
# ---------------------------------------------------------------------------
if [[ "${FORCE_BUILD:-0}" != "1" ]]; then
  if ssh "${SSH_OPTS[@]}" "${SSH_USER:-artesca-os}@$PUB_IP" \
      "sudo -n crictl images --no-trunc 2>/dev/null | grep -qE '^${IMAGE_REPO}\\s+${TAG_HASH}\\s'" \
      2>/dev/null; then
    echo "==> $FULL_IMAGE already present in containerd — skipping build"
    echo "$TAG_HASH" > "$VSS_INSTANCE_DIR/.console-image-tag"
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# Preflight: Docker on laptop
# ---------------------------------------------------------------------------
command -v docker >/dev/null || {
  echo "ERROR: docker not on PATH. Install Docker Desktop or rebuild with a" >&2
  echo "       buildx-compatible tool (podman machine, colima, orbstack)." >&2
  exit 1
}
if ! docker info >/dev/null 2>&1; then
  echo "ERROR: docker daemon not running. Start Docker Desktop and retry." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Build — force linux/amd64 since the EC2 node is amd64 and laptops are
# often arm64 (Apple Silicon). --load makes the image available locally.
#
# Persistent local buildx cache keeps `npm ci` + `next build` layers across
# reruns. Path lives outside the repo (laptop-local state). mode=max exports
# intermediate layers too so subsequent builds can resume mid-Dockerfile.
# ---------------------------------------------------------------------------
BUILDX_CACHE_DIR="${BUILDX_CACHE_DIR:-${TMPDIR:-/tmp}/nvidia-vss-console-buildx-cache}"
mkdir -p "$BUILDX_CACHE_DIR"
echo "==> building $FULL_IMAGE (platform linux/amd64, cache $BUILDX_CACHE_DIR)"
docker buildx build \
  --platform linux/amd64 \
  --tag "$FULL_IMAGE" \
  --cache-to "type=local,dest=${BUILDX_CACHE_DIR},mode=max" \
  --cache-from "type=local,src=${BUILDX_CACHE_DIR}" \
  --load \
  "$REPO_ROOT/console"

# ---------------------------------------------------------------------------
# Save + compress to a tarball
# ---------------------------------------------------------------------------
TARBALL="$(mktemp -t console-image-XXXXXX.tar.gz)"
trap 'rm -f "$TARBALL"' EXIT
echo "==> saving to $TARBALL"
docker save "$FULL_IMAGE" | gzip -3 > "$TARBALL"
ls -lh "$TARBALL" | awk '{print "   ", $5, $9}'

# ---------------------------------------------------------------------------
# Ship to node
# ---------------------------------------------------------------------------
echo "==> scp to $PUB_IP:/tmp/console-image.tar.gz"
scp "${SSH_OPTS[@]}" "$TARBALL" "${SSH_USER:-artesca-os}@$PUB_IP:/tmp/console-image.tar.gz"

# ---------------------------------------------------------------------------
# Import into containerd via a one-shot privileged Job.
# The Job mounts /usr/bin/ctr from the host so the container itself needs
# no containerd tooling — busybox is enough to exec the bind-mounted
# binary. hostPath volumes + privileged=true are the minimum needed to
# reach containerd's socket + import a file from /tmp.
# ---------------------------------------------------------------------------
JOB_NAME="console-image-import-$(date +%s)"
JOB_YAML="$(mktemp -t console-import-XXXXXX.yaml)"
# shellcheck disable=SC2064
trap "rm -f '$TARBALL' '$JOB_YAML'" EXIT
cat > "$JOB_YAML" <<YAML
apiVersion: batch/v1
kind: Job
metadata:
  name: ${JOB_NAME}
  namespace: default
  labels:
    app: console-image-import
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      tolerations:
      - operator: Exists
      containers:
      - name: importer
        # Match the host OS (Rocky 8.10, glibc 2.28) so /host-ctr resolves
        # libdl.so.2 + friends in /lib64 as it was linked. Debian's
        # /lib/x86_64-linux-gnu layout doesn't satisfy Rocky binaries.
        image: docker.io/library/rockylinux:8
        command:
        - /bin/sh
        - -c
        - |
          set -e
          echo "[importer] using host ctr: \$(/host-ctr --version)"
          # ctr import expects a plain tar stream; we ship gzipped to keep
          # the scp small. gunzip -c is part of debian:12-slim by default.
          gunzip -c /tarball/console-image.tar.gz \
            | /host-ctr --address /run/containerd/containerd.sock \
              -n=k8s.io images import -
          echo "[importer] images now in k8s.io namespace:"
          /host-ctr --address /run/containerd/containerd.sock \
            -n=k8s.io images list | grep -E '^${IMAGE_REPO}:' || true
        volumeMounts:
        - name: ctr-bin
          mountPath: /host-ctr
          readOnly: true
        - name: containerd-sock
          mountPath: /run/containerd/containerd.sock
        - name: tarball
          mountPath: /tarball
          readOnly: true
        securityContext:
          privileged: true
      volumes:
      - name: ctr-bin
        hostPath:
          path: /usr/bin/ctr
          type: File
      - name: containerd-sock
        hostPath:
          path: /run/containerd/containerd.sock
          type: Socket
      - name: tarball
        hostPath:
          path: /tmp
          type: Directory
YAML

echo "==> importing into containerd (job $JOB_NAME)"
scp "${SSH_OPTS[@]}" "$JOB_YAML" "${SSH_USER:-artesca-os}@$PUB_IP:/tmp/${JOB_NAME}.yaml" >/dev/null
ssh "${SSH_OPTS[@]}" "${SSH_USER:-artesca-os}@$PUB_IP" "$KUBECTL_REMOTE apply -f /tmp/${JOB_NAME}.yaml" >/dev/null

# Wait for completion (up to 5 min — import is local; slow disk pushes it
# past 1 min). On failure, dump events + pod logs so we can diagnose.
if ! ssh "${SSH_OPTS[@]}" "${SSH_USER:-artesca-os}@$PUB_IP" \
    "$KUBECTL_REMOTE wait --for=condition=complete --timeout=300s job/${JOB_NAME} -n default" 2>&1 | \
    sed 's/^/    [wait] /' >&2; then
  echo "ERROR: image-import Job did not complete." >&2
  echo "--- Job describe ---" >&2
  ssh "${SSH_OPTS[@]}" "${SSH_USER:-artesca-os}@$PUB_IP" \
    "$KUBECTL_REMOTE describe job ${JOB_NAME} -n default" 2>&1 | sed 's/^/    /' >&2 || true
  echo "--- Pod describe ---" >&2
  ssh "${SSH_OPTS[@]}" "${SSH_USER:-artesca-os}@$PUB_IP" \
    "$KUBECTL_REMOTE describe pod -l job-name=${JOB_NAME} -n default" 2>&1 | sed 's/^/    /' >&2 || true
  echo "--- Pod logs ---" >&2
  ssh "${SSH_OPTS[@]}" "${SSH_USER:-artesca-os}@$PUB_IP" \
    "$KUBECTL_REMOTE logs -l job-name=${JOB_NAME} -n default --tail=200" 2>&1 | sed 's/^/    /' >&2 || true
  exit 1
fi

# Success — dump the importer log so the operator has visible proof, then
# delete the Job + tarball explicitly (no TTL race).
echo "--- importer log ---"
ssh "${SSH_OPTS[@]}" "${SSH_USER:-artesca-os}@$PUB_IP" \
  "$KUBECTL_REMOTE logs -l job-name=${JOB_NAME} -n default --tail=50" 2>&1 | sed 's/^/    /' || true
ssh "${SSH_OPTS[@]}" "${SSH_USER:-artesca-os}@$PUB_IP" \
  "$KUBECTL_REMOTE delete job ${JOB_NAME} -n default --wait=false >/dev/null 2>&1; rm -f /tmp/${JOB_NAME}.yaml /tmp/console-image.tar.gz" >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# Record the tag so deploy-console.sh can set the kustomize override.
# ---------------------------------------------------------------------------
mkdir -p "$VSS_INSTANCE_DIR"
echo "$TAG_HASH" > "$VSS_INSTANCE_DIR/.console-image-tag"

echo "==> done: $FULL_IMAGE available on the node (imagePullPolicy: Never)"
echo "    tag recorded in $VSS_INSTANCE_DIR/.console-image-tag"
