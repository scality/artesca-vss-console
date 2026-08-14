# ARTESCA VSS Console

Operator console for [NVIDIA VSS](https://build.nvidia.com/nvidia/video-search-and-summarization) running on Kubernetes with [Scality ARTESCA](https://www.scality.com/artesca/) as the object store. One pane for service health, camera registration, alert scenarios, VLM prompt and inference tuning, incident playback, and what the stack has written to S3.

It runs **inside** the cluster as a `Deployment` in namespace `console`, serving `:8800`. It assumes VSS is already deployed and reachable — **it does not install or provision anything**, and it is not a VSS component: it is a separate UI that reads and patches a running stack.

Design rationale and the operator-facing intent of each page: [`docs/console-design.md`](docs/console-design.md).

> **Do not expose this to an untrusted network.** Authentication is a single shared password, the Kubernetes RBAC it requests is broad, and some pages render credentials. Those are properties of the code as published, not oversights — [SECURITY.md](SECURITY.md) lists them in full and is worth reading before you copy this into a cluster.

## What it expects

| | |
| --- | --- |
| Kubernetes | A cluster with VSS deployed. Namespace layout `vss-<profile>` (Helm) or the pre-Helm per-component layout via `CONSOLE_LEGACY_NAMESPACES=1`. |
| Object store | ARTESCA (or any S3-compatible endpoint) for recordings, evidence and KV-cache offload. |
| Node | 24 — what the image and CI both build with (`node:24.18.0-alpine`). |

Parts of the tree still assume the Scality lab: namespaces and service names are resolved in [`src/lib/cluster-refs.ts`](src/lib/cluster-refs.ts), and some code paths exist to drive an EC2 lab instance. A report that the console does not come up against a differently-named deployment is useful, not a duplicate of something obvious.

## Local dev

The app starts with nothing configured — missing `KAFKA_BROKERS`, `REDIS_URL` or `CAMERA_SIM_HOST` render as degraded or disconnected rather than crashing, so most of it can be worked on without a cluster.

```bash
cp .env.example .env.local   # every variable is documented in that file
npm install
npm run dev                  # http://localhost:5003
```

```bash
npm run lint                 # eslint src
npm test                     # vitest
npm run test:e2e             # playwright
npm run build                # next build — next.config.js sets output: "standalone"
npm start                    # serves :8800 from the standalone build
```

`npm run test:e2e` needs a built Monaco under `public/monaco/vs`; the `pretest:e2e` hook copies it. `postinstall` deliberately does not, because the Dockerfile installs with `--ignore-scripts`.

## Container

Build it yourself — this is the supported path for anyone outside Scality:

```bash
docker build -t artesca-vss-console:local .
docker run -p 8800:8800 \
  -e CONSOLE_PASSWORD=changeme \
  -e AUTH_SECRET="$(openssl rand -base64 32)" \
  -e AUTH_URL=http://localhost:8800 \
  artesca-vss-console:local
```

CI also publishes `ghcr.io/scality/artesca-vss-console:latest` and `:sha-<short-sha>` on every push to `main`. That package is currently private, so building from source is the path that works for everyone.

## Deploying to a cluster

Manifests are in [`k8s/`](k8s/) as a kustomization: namespace, RBAC, env ConfigMap, the console `Deployment`, and two PVCs.

```bash
cp k8s/10-secrets.yaml.example k8s/console-secrets.yaml   # gitignored; fill it in
kubectl apply -f k8s/console-secrets.yaml
kubectl apply -k k8s/
```

Three things that kustomization will not do for you, and each stops the pod:

- **`images.newTag` points at the private GHCR package.** Override it with the image you built (`kustomize edit set image`, or a patch).
- **The Secrets must exist first.** `console-auth` carries `CONSOLE_PASSWORD` + `AUTH_SECRET` — Auth.js reads `AUTH_SECRET`, and a Secret carrying only the `NEXTAUTH_`-prefixed spelling leaves the pod refusing every request while `src/instrumentation.ts` logs `missing env vars: AUTH_SECRET`. `console-ssh` carries the camera-sim PEM. Object-store credentials are **not** here — they come from the `objectstore-creds` Secret, remapped to `OBJECTSTORE_*` in `k8s/20-console.yaml`.
- **`30-test-footage.yaml` is not optional**, despite being a feature: `20-console.yaml` mounts the PVC it declares, and Kubernetes has no optional PVC volume, so the pod does not schedule without it.

The console also needs a `console-writer` Role and RoleBinding in each namespace it patches, since it reads pods and patches ConfigMaps outside its own namespace. `01-rbac.yaml` covers namespace `console`; grant the equivalent in each `vss-<profile>` namespace you point it at.

## Pages

23 pages — 22 in the nav, grouped as the sidebar groups them, plus `/cameras/bindings`.

### Live

| Route | Purpose |
| ----- | ------- |
| `/` | Overview — two views (operator and presenter), cluster health, pod summary, active incidents |
| `/topology` | Single-frame path diagram (camera-sim → VST → RTVI VLM → Agent → S3) with per-component health from `/api/pods` |
| `/incidents` | Incident timeline, live over SSE; detail with clip playback. Kiosk mode (`?mode=kiosk`) hides the nav |
| `/cameras` | Camera registration — writes the `cameras` ConfigMap and the canonical copy in the config store |
| `/cameras/bindings` | Which scenarios each camera is bound to (not in the nav; reached from `/cameras`) |

### AI & Storage

| Route | Purpose |
| ----- | ------- |
| `/search` | Semantic search over the VLM caption archive; results are clip-thumbnail cards with playback |
| `/analytics` | "Ask the store" — plain-English questions over the incident archive |
| `/chat` | Conversational chat with the vss-agent |
| `/evidence` | Immutable evidence via ARTESCA S3 Object Lock (WORM) |
| `/storage` | Per-bucket object counts, bytes, 24 h written, and a stream of objects as they land |
| `/kvcache` | KV-cache offload telemetry — model, endpoint, bucket objects and bytes, warnings, live cost timings |

### Configure

| Route | Purpose |
| ----- | ------- |
| `/scenarios` | Alert-keyword scenarios and per-scenario cooldown |
| `/prompt` | VLM system prompt (Monaco) and model deployment-name swap |
| `/tuning` | VST recording, alerting and VLM inference knobs, split across ConfigMap and Deployment env; Save + Restart patches both and rolls the workloads |
| `/agent` | Agent configuration (system prompt, model preset incl. provider) and its tool catalog |
| `/test-footage` | Replay a local video file through the real pipeline to test the prompt and scenarios on actual frames |
| `/profiles` | Operator-defined scenes — saved prompt + scenario + tuning bundles |

### System

| Route | Purpose |
| ----- | ------- |
| `/secrets` | Cluster secret status and rotation |
| `/logs` | Pod log tail across namespaces |
| `/diagnostics` | Cluster health probes, GPU utilisation, Kafka consumer lag, VST storage panel |
| `/sizing-studio` | Embedded sizing studio |
| `/settings` | Auth, secret rotation, app version |
| `/about` | Build info, the resolved service-endpoint table, and whether telemetry is compiled in and configured |

## Env vars

[`.env.example`](.env.example) documents 43 variables, each with what it does and what breaks without it — the ones you need to get the app up, point it at your own object store, and see its logs.

**It is not the full set.** `src/` reads **136**, of which 38 are documented here — so **98 are not** (the other 5 in this file are consumed by Auth.js and the AWS SDK rather than read directly). They are mostly service URLs, Kafka topic names and ConfigMap keys with working defaults derived from `VSS_NAMESPACE`, which is why nothing appears broken without them. When something is misbehaving and you suspect configuration, [`src/lib/cluster-refs.ts`](src/lib/cluster-refs.ts) resolves most of them in one place and `git grep 'process\.env\.' src/` is the authority. Closing that gap is [#6](https://github.com/scality/artesca-vss-console/issues/6); a patch that documents one coherent group of them is a good first contribution.

## Telemetry

Off by default and in two independent ways: the Sentry SDK is not installed unless you opt in (`npm run enable-telemetry`, or `--build-arg WITH_TELEMETRY=1`), and no DSN ships in this tree. A build made from this repository reports nowhere. See [`docs/console-sentry.md`](docs/console-sentry.md).

## Issues and contributing

Bugs, feature requests and questions go to
[GitHub Issues](https://github.com/scality/artesca-vss-console/issues) on this
repository — that is the tracker. Setup, conventions and what is in scope:
[CONTRIBUTING.md](CONTRIBUTING.md).

Vulnerabilities do **not** go in an issue. Use the Security tab's private
reporting flow; [SECURITY.md](SECURITY.md) also lists the known limitations of a
default deployment, which are worth reading before copying this into a cluster.

`ISVD-…` keys in the source and the git history refer to Scality's internal
tracker and are not publicly readable. They are provenance markers, not links.

## Licence

Apache License 2.0 — see [LICENSE](LICENSE). Copyright Scality.

`private: true` stays in `package.json`: the deliverable is a container image, not an npm package, and the flag is what stops an accidental publish. It does not restrict the licence grant.
