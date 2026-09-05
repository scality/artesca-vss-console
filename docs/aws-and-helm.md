# The console's AWS posture and VSS 3.2 Helm compatibility

> Moved verbatim from `CLAUDE.md` on 2026-09-05. Dated design record — measured figures are as of the dates stated.

## AWS — the console has no AWS credentials

**Nothing in this console calls an AWS service, and no Secret gives it the means
to.** That is the property to preserve: it runs on a customer's ARTESCA cluster,
where there is no AWS account to act in.

[`src/lib/aws.ts`](src/lib/aws.ts) is **not** AWS despite the name — `s3Stats` /
`s3SubstrateStats` speak the S3 protocol against `OBJECTSTORE_ENDPOINT`, which on
a real deployment is the ARTESCA connector. They back the storage panels and are
part of the product. Renaming that file is open on ISVD-610.

Two consequences worth knowing before adding an AWS call:

- **`@aws-sdk/client-ec2` is not a dependency.** `@aws-sdk/client-s3` is, for the
  protocol, not the provider.
- **`s3Region()` is a signing region, not a routing decision.** ARTESCA does not
  route on it, but the SDK requires one. `k8s/11-configmap-env.yaml` sets
  `OBJECTSTORE_REGION` explicitly so it is a choice rather than a default. ⚠ Two
  fallbacks disagree when it is unset — [s3.ts](src/lib/s3.ts) yields `us-west-2`
  and [cluster-refs.ts](src/lib/cluster-refs.ts) `us-east-1`.

**Network access is the lab's job.**
`scality/isv-labs/scripts/providers/aws/seed-sg-whitelist.sh` writes the EC2
security-group ingress rules for every admin port, and describes itself as the
source of truth. `/settings` held a panel over the same security group until
ISVD-610, and it never worked on any deployment: it read `CONSOLE_SG_ID` while
every provisioner supplied `VSS_INSTANCE_SG_ID`, so both write paths answered
`500 CONSOLE_SG_ID env var not configured` for the panel's whole life. Four gates
each checked one side of that and none compared them — the route unit tests set
the variable themselves, the smoke test provisioned the real name and never
called the route, the E2E spec intercepted the request in the browser, and
`docs/console-config-validation.md` listed the Secret's keys, which were correct.

[tests/unit/env-contract.test.ts](tests/unit/env-contract.test.ts) is what
survived that: it compares the names `src/instrumentation.ts` declares required
against the names the manifests supply, which is the comparison none of the four
made. Repointing it there immediately caught a second instance —
`10-secrets.yaml.example` provisioned `NEXTAUTH_SECRET`, a spelling Auth.js reads
nothing from, so an operator following the example got a pod that refused every
request while `k8s/README.md` carried that outcome as a *troubleshooting row*
rather than a fixed example. It is scoped to the declared-required list because
separating a required read from an optional override is not syntactic: 136 env
names are read across `src/`, 76 are unprovisioned optional overrides, and
absence is handled in five shapes. Widening it means routing required reads
through one accessor — ISVD-672.

⚠ **An `sg_whitelist` table survives on the PVC of any console that already
ran.** Nothing creates or reads it. It is left rather than dropped: those rows
were only ever a mirror of AWS, which remains the source of truth, so a
data-deleting migration buys nothing over an unused table.

## VSS 3.2 Helm compatibility

The Helm path is the default and targets the NVIDIA VSS 3.2 chart (internal version `3.2.0-26.05.5`; clone at `../refs/video-search-and-summarization` @ `dev-26.06.1-2`). Most object names match the chart as-deployed: namespace `vss-base` (via `VSS_NAMESPACE`), `vss-vios-{sensor,streamprocessing,ingress}`, `vss-rtvi-vlm`, `vss-agent`, broker `kafka-kafka` (Confluent Kafka KRaft), `redis`, the `VLM_SYSTEM_PROMPT` env on the VLM Deployment, and NIM tuning keys `NIM_KVCACHE_PERCENT` / `NIM_MAX_MODEL_LEN` / `NIM_MAX_NUM_SEQS`.

**Kafka is only reachable from outside the VSS namespace because of an overlay patch.** The chart sets `KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://kafka-kafka:9092` — a bare service name, which resolves only inside `vss-<profile>`. In-namespace clients are fine, so the defect is invisible from there; the console (ns `console`) bootstraps on the FQDN, receives the bare name back in the cluster metadata, and cannot resolve it. kafkajs reads that as a broker crash and reconnects forever (~300 ms loop, measured on the showroom until 2026-08-05). [`k8s/nvidia-vss-helm-overlay/70-kafka-advertised-listener-patch-job.yaml`](isv-labs:k8s/nvidia-vss-helm-overlay/70-kafka-advertised-listener-patch-job.yaml) re-advertises the FQDN and restarts the broker; it is idempotent and runs on every install/upgrade. Setting `KAFKA_BROKERS` alone does **not** fix it. ISVD-506. Consumers additionally give up after `MAX_CONSUMER_RESTARTS` (5) crashes rather than looping — see [`src/lib/kafka.ts`](src/lib/kafka.ts). On the `alerts` profile the `vision-embed-*` topics do not exist, so one `kafka error tap not started` warn per topic at startup is expected.

The deployed object set is **profile-dependent** — the chart is parameterized (conditional subcharts, model-slug placeholders, `useReleaseNamePrefix`). The `cluster-refs.ts` defaults are calibrated to the **`alerts` profile** (the Pyramid showroom profile, ns `vss-alerts`). **Validated 2026-06-13 against a live g7e `alerts` deploy** — the defaults are correct for alerts; the env-overrides cover the `base` profile, where the deployed objects differ. Match a different profile via [`k8s/console/11-configmap-env.yaml`](k8s/11-configmap-env.yaml), no code change; confirm with `kubectl -n <vss-ns> get svc,deploy,cm` + `kafka-topics --list`.

| What | Default | `alerts` profile (validated 2026-06-13) | `base` profile | Env override |
| ---- | ------- | --------------------------------------- | -------------- | ------------ |
| RTVI embed | `vss-rtvi-vlm` (collapsed) | ✅ correct — **no `vss-rtvi-embed`** (embed subchart disabled in alerts) | `vss-rtvi-embed` is a distinct Cosmos Embed1 Deployment/Service:8000 | `RTVI_EMBED_DEPLOYMENT` |
| VLM-tuning NIM + CM | NIM `nvidia-nemotron-nano-9b-v2`, CM `…-nim-env` | ✅ correct — only the nemotron NIM is deployed; no separate cosmos NIM | base deploys the `nvidia-cosmos-reason2-8b` VLM NIM (+ `…-nim-env`) | `NIM_TUNING_DEPLOYMENT`, `NIM_TUNING_CONFIG_MAP` |
| Kafka topics | `mdx-vlm`, `mdx-vlm-incidents`, `vision-llm-errors`, `vision-embed-messages`, `vision-embed-errors`, … | `mdx-vlm` / `mdx-vlm-incidents` / `vision-llm-errors` ✅ exist; `vision-embed-{messages,errors}` ❌ absent (no embed pipeline in alerts → dead but harmless subscriptions) | embed topics exist when the embed subchart is on | `KAFKA_TOPIC_*` |
| `NIM_MODEL_PROFILE` | free-text, empty = auto-detect (recommended) ([RtviTuningForm.tsx](src/components/tuning/RtviTuningForm.tsx)). The VLM picks the profile for the detected GPU; pin a hash only from the running NIM's `list-model-profiles` for the actual GPU — hashes are model/NIM-version/GPU-specific and a foreign-GPU hash fails with "no compatible profile". | same | same | — |
| NIM preview endpoint | `nvila-lite-preview.<ns>:8000` | `nvila` absent — repoint at `vss-rtvi-vlm` / the deployed NIM | same | `NIM_PREVIEW_ENDPOINT` |

`CONSOLE_LEGACY_NAMESPACES=1` switches the whole layout back to the pre-Helm per-namespace scheme (`vst`/`rtvi`/`agent`/`alerts`) for fixture instances.
