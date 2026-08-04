# Scenarios and VLM prompt

Source files: [`console/src/app/scenarios/`](../../../console/src/app/scenarios/), [`console/src/app/prompt/`](../../../console/src/app/prompt/), [`scripts/sync-scenarios.sh`](../../../scripts/sync-scenarios.sh), [`scripts/sync-prompt.sh`](../../../scripts/sync-prompt.sh), [`scripts/stacks/nvidia-vss/default-vlm-prompt.txt`](../../../scripts/stacks/nvidia-vss/default-vlm-prompt.txt).

---

## Scenarios

### What they are

Alert scenarios are declarative rules — keyword triggers, cooldown windows, severity levels, and alert-type categories — consumed by the alert-worker in [`k8s/nvidia-vss/alerts/`](../../../k8s/nvidia-vss/alerts/). The alert-worker watches Kafka for VLM-generated captions and emits incidents when captions match scenario keywords within their cooldown window.

Scenarios persist to two surfaces:

| Surface | Key | When used |
|---|---|---|
| ConfigMap `scenarios` in ns `alerts`, key `scenarios.yaml` | live cluster state | alert-worker mounts this ConfigMap |
| GCS canonical `gs://scality-isv-labs-config/scenarios/<instance>.json` | schema `isv-labs.scenarios.v1` | cross-deploy canonical; restored on cluster restart |

### Edit a scenario (console UI)

1. Open `/scenarios` on the console.
2. Select a scenario from the list.
3. Edit keywords, cooldown window (seconds), severity (`low` / `medium` / `high`), and category tag.
4. Click **Save**.

Behind the scenes: `gcsScenariosPut` writes a new versioned object to GCS; the ConfigMap is patched; the alert-worker re-reads on a debounce — no pod restart needed.

### Edit a scenario (CLI fallback)

```bash
# Pull current scenarios for this instance
scripts/sync-scenarios.sh --pull --instance <name>

# Edit scripts/instances/<name>/scenarios.json locally, then push
scripts/sync-scenarios.sh --push --instance <name> --file scripts/instances/<name>/scenarios.json

# Restore from GCS to the live cluster
scripts/sync-scenarios.sh --restore --instance <name> --nvidia-vss-host <host>
```

### Pyramid showroom scenarios

Three scenarios drive the June 2026 Germany workshops (source: `scripts/stacks/nvidia-vss/CLAUDE.md`):

1. Self-checkout theft / scan verification (EUROSHOP reference)
2. Shelf heat-mapping (stock levels, restock alerts)
3. Supply-chain / pallet tracking (chains with scenario 2)

---

## VLM prompt

### What it is

The VLM system prompt is the instruction the `rtvi-vlm` pod passes to the Cosmos Reason 2 NIM for every frame evaluation. It defines what the model looks for and how to respond.

Default prompt: [`scripts/stacks/nvidia-vss/default-vlm-prompt.txt`](../../../scripts/stacks/nvidia-vss/default-vlm-prompt.txt).

```
You are a retail loss-prevention monitor for a self-checkout aisle. For each
frame, detect: (a) items moved past the scanner without a beep, (b) an item
placed directly into a bag or pocket without scanning, (c) abnormally fast hand
movements over the bagging area, (d) shelves with visibly empty rows. Reply
with "Yes" or "No" followed by a single short justification sentence.
```

The active prompt persists to two surfaces:

| Surface | Key | When used |
|---|---|---|
| ConfigMap `rtvi-runtime-env` in ns `rtvi`, key `RTVI_VLM_SYSTEM_PROMPT` | live cluster state | `rtvi-vlm` mounts this ConfigMap |
| GCS canonical `gs://scality-isv-labs-config/prompt/<instance>.json` | schema `isv-labs.prompt.v1` | cross-deploy canonical; restored on cluster restart |

### Swap the prompt (console UI)

1. Open `/prompt` on the console.
2. Edit the prompt text in the textarea.
3. Click **Save**.

Behind the scenes: `gcsPromptPut` writes a new versioned object to GCS; the ConfigMap is patched; `rtvi-vlm` picks up the new value on next reconcile or pod restart.

### Swap the prompt (CLI fallback)

```bash
# Push a plain-text prompt file to GCS
scripts/sync-prompt.sh --push --instance <name> --prompt-file scripts/stacks/nvidia-vss/default-vlm-prompt.txt

# Restore from GCS to the live cluster ConfigMap
scripts/sync-prompt.sh --restore --instance <name> --nvidia-vss-host <host>
```

Pull current state:
```bash
scripts/sync-prompt.sh --pull --instance <name>
scripts/sync-prompt.sh --status --instance <name>
```

### Tuning page — model and inference knobs

The Tuning page (`/tuning`) exposes 7 inference knobs split across two K8s resources (source: `console/CLAUDE.md`):

**ConfigMap `rtvi-runtime-env`** (no pod restart needed unless Save+Restart is clicked):
- `max_num_seqs` — max concurrent sequences in the vLLM scheduler
- `kv_cache_percent` — maps to `gpu_memory_utilization` in the NIM (`NIM_KVCACHE_PERCENT`)
- `max_model_len` — context window length (`NIM_MAX_MODEL_LEN`)
- `NIM_MODEL_PROFILE` — NGC profile SHA override (for pinning Eagle-2 speculative decoding)

**`rtvi-vlm` Deployment env** (Save+Restart patches + rolls the pod):
- `NIM_DISABLE_CUDA_GRAPH` — set `"1"` to disable CUDA graph captures (reduces VRAM usage at cost of throughput)
- `VLLM_NUM_SCHEDULER_STEPS` — scheduler steps per iteration
- `VLLM_MAX_NUM_BATCHED_TOKENS` — tokens per batch

Save+Restart atomically patches both surfaces and rolls the NIM workload + `rtvi-vlm` Deployment.

Operator-facing preset configs (Pyramid showroom, lab A/B, laptop dev) with per-knob explanations: [`docs/vss-performance-tuning.md`](../../../docs/vss-performance-tuning.md).
