# Demo Console — `:8800` (local dev `:5003`)

Operator console for the ARTESCA × Pyramid × NVIDIA VSS stack. Single-pane-of-glass for service status, live metrics, camera management, scenario editing, VLM prompt tuning, and incident playback.

Deploys as a K8s `Deployment` in namespace `console` on the ARTESCA MetalK8s node — not to Vercel. See `docs/console-design.md` for the full design rationale.

## Local dev

```bash
cd console
cp .env.example .env.local   # fill in values
npm install
npm run dev                  # http://localhost:5003
```

The app starts without external services configured. Missing `KAFKA_BROKERS`, `REDIS_URL`, or `CAMERA_SIM_HOST` return degraded/disconnected states — no crash.

## Build

```bash
npm run build   # next build --standalone
npm start       # serves :8800 from .next/standalone (prod / in-cluster pod)
```

## Docker

```bash
docker build -t console:local .
docker run -p 8800:8800 \
  -e CONSOLE_PASSWORD=changeme \
  -e AUTH_SECRET=devsecret \
  -e AUTH_URL=http://localhost:8800 \
  console:local
```

## Pages

| Route | Purpose |
| ----- | ------- |
| `/` | Overview — cluster health, pod summary, active incidents |
| `/topology` | Service graph — namespace, pod, and dependency map |
| `/incidents` | Incident list + detail; kiosk-mode (`?mode=kiosk`) hides nav |
| `/cameras` | Camera registry, feed status, add-camera stepper |
| `/scenarios` | Scenario keyword editor, threshold tuning |
| `/prompt` | VLM prompt editor (Monaco), model selector, live preview |
| `/tuning` | Three tuning cards: **RTVI** (NeMo inference params), **Alerts** (Kafka thresholds), and **VST Recording** (recording mode, GoP / `default_gov_length`, H264/H265 codec selection, storage threshold, file retention). Changes to the VST card patch `vst-config` ConfigMap and trigger a rollout-restart of `sensor-ms` + `streamprocessing-ms` with a ~10 s recording gap. |
| `/diagnostics` | Cluster diagnostics. Leads with a **VST Storage** panel: S3 PUT rate with 5-min sparkline, object count, local `vst-video` cache fill percentage, segment histogram, and frame-drop rate. Below: pod logs, GPU utilisation, Kafka consumer lag. |
| `/demo-data` | Synthetic VLM event generator (exercises alerts without GPU) |
| `/profiles` | Load/save named config profiles (snapshot + restore tuning state) |
| `/secrets` | S3 credentials and cloud-storage fields — the fields excluded from `/tuning` |
| `/logs` | Structured log viewer with namespace + pod filter |
| `/settings` | Console settings (auth, AUTH_URL, theme) |

## Tests

```bash
npm test        # vitest (unit)
npm run test:e2e  # playwright
```

## K8s deploy

Manifests live in `k8s/` (owned by a parallel agent). The console Deployment mounts:
- `console-auth` Secret → `CONSOLE_PASSWORD` + `AUTH_SECRET` (Auth.js reads `AUTH_SECRET`; a Secret carrying only the `NEXTAUTH_`-prefixed spelling leaves the pod refusing every request)
- `console-aws` Secret → AWS credentials
- `console-data` PVC at `/data` → SQLite (`console-data.db`)
- camera-sim SSH key Secret → `CAMERA_SIM_SSH_KEY_PATH`

## Env vars

See `.env.example` for the full list with descriptions.

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
