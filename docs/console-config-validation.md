# Console Config Validation Runbook

Post-deploy checklist for validating the VSS Demo Console with store-backed
runtime config, prompt-sets, and the VLM `Recreate` strategy fix.
> **This is a Scality-lab runbook.** The `deploy-console.sh` /
> `reconcile-agent-deploy.sh` / `validate-console.sh` commands below are
> Scality-internal tooling acting on a named lab instance, and are not part of
> this repository. The *checks* they bracket are generic — read them as "what to
> verify after a deploy", and substitute your own deploy step. For a
> from-scratch deploy see the README's "Deploying to a cluster".

> **Which config-store backend is this instance on?** `/about` names it. The default
> is the YAML file store, which needs no GCP project, no service-account key and no
> `datastore.user` grant — so **step 1 below applies only to an instance on the
> Firestore backend**, and everything after it is backend-agnostic. See
> [`console-config-store.md`](console-config-store.md) for the selection rule (unset
> is not the same as `file`) and the migration procedure.

---

## Prerequisites

### 1. Firestore database + SA role — *Firestore backend only*

The console and reconcile-agent read/write Firestore in GCP project `isv-alliances`
(`(default)` database). Verify before deploying:

```bash
# Confirm the Firestore (default) database exists
gcloud firestore databases list --project=isv-alliances

# Confirm the Secret Manager secret exists (needed by deploy-console.sh)
gcloud secrets versions access latest --secret=config-store-rw-key \
  --project=isv-alliances --format=json | python3 -c 'import sys,json; d=json.load(sys.stdin); print("ok" if d else "empty")'

# Confirm the SA key's service account holds datastore.user
# First extract the SA email from the key JSON:
SA_EMAIL=$(gcloud secrets versions access latest --secret=config-store-rw-key \
  --project=isv-alliances | python3 -c 'import sys,json; print(json.load(sys.stdin)["client_email"])')
# Then check its binding on the project:
gcloud projects get-iam-policy isv-alliances \
  --flatten="bindings[].members" --format="table(bindings.role,bindings.members)" \
  | grep "$SA_EMAIL"
# Must include roles/datastore.user
```

If the SA lacks `roles/datastore.user`, config reads/writes **fail-soft** — the UI
loads with `warnings[]` and shows empty cameras/prompt/scenarios. This is not
obvious from the page loading; verify explicitly.

### 2. kubectl context

```bash
kubectl get nodes   # must reach the cluster
```

### 3. Console secrets scaffold (auto-created by deploy-console.sh)

`deploy-console.sh` auto-scaffolds `k8s/console/10-secrets.yaml` on first deploy
using `ensure-console-iam.sh`. The three secrets it creates in ns `console` are:

| Secret | Keys |
|--------|------|
| `console-auth` | `CONSOLE_PASSWORD`, `AUTH_SECRET` |
| `console-ssh` | `id_ed25519` (camera-sim PEM) |

The `config-store-rw` secret (Firestore key) is also created by `deploy-console.sh`
from GCP Secret Manager `config-store-rw-key` (project `isv-alliances`).
If `gcloud` auth is stale, the script exits with an explicit error.

---

## Step 1 — Deploy console + reconcile-agent

> **Both deployments are required.** If only the console is deployed and the
> reconcile-agent is skipped: fresh instances get **no seeded default prompt-set**
> (blank `/prompt` page) and **no Firestore→cluster drift convergence** (edits
> write through but nothing re-applies after a workload restart). Interactive
> write-through via the console still works; seeding and background convergence
> do not.

```bash
# 1a. Build or pull the image, sideload to the node, apply the k8s/ manifests
isv-labs:scripts/deploy-console.sh --instance <instance-name>

# 1b. Apply k8s/reconcile-agent manifests (reuses the image built above)
isv-labs:scripts/reconcile-agent-deploy.sh --instance <instance-name>
```

Verify both pods are Ready:

```bash
kubectl -n console get pods
# Expected: console-<hash>  1/1  Running
#           reconcile-agent-<hash>  1/1  Running
```

Verify the reconcile-agent started and completed the one-shot seed:

```bash
kubectl -n console logs deploy/reconcile-agent --tail=80
```

Look for these two lines (from [`console/src/lib/reconcile-agent.ts`](../src/lib/reconcile-agent.ts)):

```
reconcile agent started — instance=<name> interval=60s
reconciled <name>: +N cameras, prompt=true, scenarios=true, 0 error(s), ...
```

If `VSS_INSTANCE_NAME` was not injected (placeholder not substituted by
`reconcile-agent-deploy.sh`), the agent logs:

```
RECONCILE_AGENT set but VSS_INSTANCE_NAME missing — agent idle
```

Fix: re-run `scripts/reconcile-agent-deploy.sh --instance <name>`. The deploy
script substitutes the `<vss-instance-name>` placeholder in
``k8s/reconcile-agent/20-deployment.yaml``.

---

## Step 2 — Verify the default prompt-set was seeded

The reconcile-agent runs a one-shot idempotent seed on startup
([`console/src/lib/reconcile/prompt-seed.ts`](../src/lib/reconcile/prompt-seed.ts)):
if the instance has no prompt-sets, it creates a set `{ id: "default", name: "Default (Retail LP)" }`
and marks it active in Firestore under `instances/<instance>/prompts` +
`activePromptId`.

**Verify via the console UI:**

1. Open `http://<NODE_IP>:8800/prompt`
2. Confirm the "Default (Retail LP)" preset card is present and marked as active.

**Optional — verify via Firestore directly:**

```bash
gcloud firestore documents get \
  projects/isv-alliances/databases/'(default)'/documents/instances/<instance>/prompts/default \
  --format=json
# Should return a document with "name": "Default (Retail LP)"
```

If the page is blank (no prompt-sets), the agent either did not run (Step 1
skipped), `VSS_INSTANCE_NAME` was missing (agent idle), or the config store
could not be reached (check agent logs for `config store init failed`).

---

## Step 3 — Prompt write-through + VLM Recreate

**3a. Write a prompt edit:**

In the console at `/prompt`, activate the "Default (Retail LP)" set or edit its
text and save.

**3b. Confirm VLM convergence:**

The reconcile-agent patches `VLM_SYSTEM_PROMPT` directly on the `vss-rtvi-vlm`
Deployment (Helm path: no intermediate ConfigMap; `runtimeEnvCm = ""`).
After the next agent tick (≤60s), a new VLM pod starts.

```bash
# Watch the VLM rollout in the active VSS namespace
VSS_NS="vss-alerts"   # or vss-base — match SCALITY_BP_PROFILE
kubectl -n "$VSS_NS" rollout status deployment/vss-rtvi-vlm --timeout=10m
```

**3c. Confirm Recreate strategy:**

```bash
kubectl -n "$VSS_NS" get deploy vss-rtvi-vlm \
  -o jsonpath='{.spec.strategy.type}'
# Must return: Recreate
```

`Recreate` is set by two independent mechanisms:

1. `scripts/stacks/nvidia-vss/bootstrap-helm-deploy.sh` patches the Deployment
   immediately after the Helm install (line 313–315).
2. The reconcile-agent asserts it on every tick via
   [`console/src/lib/reconcile/vlm-strategy.ts`](../src/lib/reconcile/vlm-strategy.ts) →
   `reconcileVlmStrategy()`.

If `strategy.type` is `RollingUpdate`, the Helm post-install patch did not run
or was overwritten; re-run `bootstrap-helm-deploy.sh` or apply the patch manually:

```bash
kubectl -n "$VSS_NS" patch deploy vss-rtvi-vlm \
  --type=merge -p '{"spec":{"strategy":{"type":"Recreate","rollingUpdate":null}}}'
```

---

## Step 4 — Cameras converge

Add a camera in the console at `/cameras` and save. The reconcile-agent reads
the desired state from Firestore (`instances/<instance>/cameras`) and fires
a `register-cameras` Job in ns `pyramid-ingress`.

```bash
# Confirm the Job was created
kubectl -n pyramid-ingress get jobs | grep register-cameras
# Confirm it completed
kubectl -n pyramid-ingress get jobs -o jsonpath='{range .items[*]}{.metadata.name} {.status.conditions[?(@.type=="Complete")].status}{"\n"}{end}'
```

Confirm the sensor appears in VST:

```bash
# Sensor list endpoint (Helm path, vss-alerts example)
kubectl -n console exec deploy/console -- \
  curl -sf http://vss-vios-sensor.vss-alerts.svc.cluster.local:30000/api/v1/sensor/list \
  | python3 -m json.tool | grep -E '"name"|"sensorUrl"'
```

If the sensor is absent, check the `register-cameras` Job logs:

```bash
kubectl -n pyramid-ingress logs job/<register-cameras-job-name>
```

---

## Step 5 — Scenarios converge

Edit a scenario keyword in the console at `/scenarios` and save. The
reconcile-agent writes the updated content to ConfigMap `scenarios` in ns
`pyramid-ingress` (Helm path).

```bash
# Verify ConfigMap was updated (check the last-updated annotation or data diff)
kubectl -n pyramid-ingress get cm scenarios -o yaml | grep -A5 'scenarios.yaml'
```

---

## Failure modes — quick triage

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `/prompt` page blank — no prompt-set cards | Reconcile-agent not deployed, or agent idle (`VSS_INSTANCE_NAME` missing), or Firestore read failed | Check agent logs: `kubectl -n console logs deploy/reconcile-agent --tail=50`. Look for `agent idle` or `config store init failed`. Re-run `scripts/reconcile-agent-deploy.sh`. |
| Console loads but cameras / scenarios always show empty after edits | SA missing `roles/datastore.user` on GCP project `isv-alliances` | Console writes fail-soft and return `warnings[]`. Grant the SA role, re-check agent logs for `config-store` errors. |
| VLM stuck rolling — pods pending, `kubectl describe` shows `Insufficient nvidia.com/gpu` | `strategy.type=RollingUpdate` — old pod holds the GPU, new pod cannot schedule | Check: `kubectl -n <vss-ns> get deploy vss-rtvi-vlm -o jsonpath='{.spec.strategy.type}'`. Patch to `Recreate` (see Step 3c). |
| VLM crashloop — `Failed to load VLM on GPU 0` | `runtimeClassName` not set — GPU driver not injected (MetalK8s/runc path) | Verify `bootstrap-helm-deploy.sh` Job `gpu-runtimeclass-patch` completed: `kubectl -n <vss-ns> logs job/gpu-runtimeclass-patch` |
| Config edits in the console UI do not propagate to the cluster | Reconcile-agent is down or erroring on every tick | `kubectl -n console get deploy reconcile-agent` — check Ready. `kubectl -n console logs deploy/reconcile-agent --tail=100` for tick errors. |
| `deploy-console.sh` exits with "could not fetch config-store-rw-key" | `gcloud` ADC stale or SA key missing from Secret Manager. Reached **only on the Firestore backend** — the fetch is gated on the resolved `CONSOLE_CONFIG_STORE`, so a file-backend instance never makes this call | `gcloud auth login --update-adc`, then confirm `gcloud secrets versions access latest --secret=config-store-rw-key --project=isv-alliances` returns non-empty output. Or remove the dependency instead of repairing it: migrate the instance to the file backend ([`console-config-store.md`](console-config-store.md)), which needs no GCP account. |

---

## Smoke shortcut

For a quick pod-Ready + HTTP health gate (does not cover Firestore or convergence):

```bash
isv-labs:scripts/validate-console.sh --instance <instance-name>
# Checks: deployment console readyReplicas≥1, pvc console-data Bound,
#         serviceaccount console-sa, GET /api/health/self → {"status":"ok"}
```

For the reconcile-agent specifically:

```bash
kubectl -n console get deployment reconcile-agent \
  -o jsonpath='ready={.status.readyReplicas}/{.spec.replicas}{"\n"}'
kubectl -n console logs deploy/reconcile-agent --tail=20
```
