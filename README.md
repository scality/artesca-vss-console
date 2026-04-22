# Demo Console — `:8800`

Operator console for the ARTESCA × Pyramid × NVIDIA VSS stack. Single-pane-of-glass for service status, live metrics, camera management, scenario editing, VLM prompt tuning, and incident playback.

Deploys as a K8s `Deployment` in namespace `console` on the ARTESCA MetalK8s node — not to Vercel. See `../docs/console-design.md` for the full design rationale.

## Local dev

```bash
cd console
cp .env.example .env.local   # fill in values
npm install
npm run dev                  # http://localhost:8800
```

The app starts without external services configured. Missing `KAFKA_BROKERS`, `REDIS_URL`, or `CAMERA_SIM_HOST` return degraded/disconnected states — no crash.

## Build

```bash
npm run build   # next build --standalone
npm start       # serves :8800 from .next/standalone
```

## Docker

```bash
docker build -t console:local .
docker run -p 8800:8800 \
  -e CONSOLE_PASSWORD=changeme \
  -e NEXTAUTH_SECRET=devsecret \
  -e NEXTAUTH_URL=http://localhost:8800 \
  console:local
```

## Tests

```bash
npm test        # vitest (unit)
npm run test:e2e  # playwright
```

## K8s deploy

Manifests live in `../k8s/console/` (owned by a parallel agent). The console Deployment mounts:
- `console-auth` Secret → `CONSOLE_PASSWORD`
- `console-aws` Secret → AWS credentials
- `console-data` PVC at `/data` → SQLite (`console-data.db`)
- camera-sim SSH key Secret → `CAMERA_SIM_SSH_KEY_PATH`

## Env vars

See `.env.example` for the full list with descriptions.
