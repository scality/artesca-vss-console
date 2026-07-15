# Console observability — Sentry runbook

The in-cluster console reports errors, traces, and masked session replays to Sentry. Mirrors the [deployer setup](deployer-sentry.md); the differences (in-cluster pod, image-build source-map upload) are called out below.

| Fact | Value |
| ---- | ----- |
| Org / project | `scality-3i` / `scality-vss-console-ui` (project id `4511738391494736`) |
| Region | `de.sentry.io` (EU data residency) |
| Issues UI | https://scality-3i.sentry.io/issues/?project=4511738391494736 |
| SDK | `@sentry/nextjs`, all three runtimes (browser / Node / edge) |
| Environments | `development` (laptop `npm run dev`) · `production` (in-cluster console pod) |
| Release | image tag hash (laptop sideload) / `sha-<short>` (CI GHCR build) |
| Build secret | GCP Secret Manager `isv-labs-sentry-build-env` (project `isv-alliances`) — shared with the deployer; org + token reused, project overridden to `scality-vss-console-ui` |

The DSN is inlined as the `CONSOLE_SENTRY_DSN` fallback in [`console/sentry.server.config.ts`](../console/sentry.server.config.ts) (and the matching literals in the edge / client configs), so every pod reports without env plumbing. It is an ingest-only identifier, not a secret. `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` (via the `console-env` ConfigMap) override it.

## What's instrumented

- **Errors**: unhandled server route errors (`onRequestError` in [`console/src/instrumentation.ts`](../console/src/instrumentation.ts)), root-layout React errors ([`console/src/app/global-error.tsx`](../console/src/app/global-error.tsx)), browser errors.
- **Tracing**: 100% sampled in dev, 10% in production, on every runtime.
- **Session replay**: 10% of sessions, 100% of error sessions — fully masked (see below).
- **Tunnel**: browser events proxy through the app at `/monitoring` (`tunnelRoute` in [`console/next.config.js`](../console/next.config.js)) so ad-blockers don't drop them.

Init files: [`console/src/instrumentation-client.ts`](../console/src/instrumentation-client.ts) (browser), [`console/sentry.server.config.ts`](../console/sentry.server.config.ts) (Node), [`console/sentry.edge.config.ts`](../console/sentry.edge.config.ts) (edge), loaded from [`console/src/instrumentation.ts`](../console/src/instrumentation.ts) ahead of the background watchers/reconcile loop. The DSN is a hardcoded fallback (an ingest-only identifier, ships in the client bundle by design) so the pod reports without env plumbing; `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` (settable in the `console-env` ConfigMap) override it.

## Secret-leak hardening — the constraints that must hold

The console holds lab secrets (objectstore/S3 keys, the camera-sim SSH PEM, the Firestore SA key) in server-side locals, logs cluster command lines, and renders credentials as text (Grafana/Keycloak passwords on Overview, the Secrets page, S3 endpoint keys). Three SDK features are therefore deliberately off / pinned, and **must stay that way when anyone adds a Sentry signal later**:

| Setting | State | Why |
| ------- | ----- | --- |
| `includeLocalVariables` | off (server) | frame locals routinely hold key material |
| `enableLogs` | off (all runtimes) | forwarded console/log lines carry cluster command lines and fetched secret state |
| Replay masking | pinned explicit (`maskAllText`, `maskAllInputs`, `blockAllMedia`, `networkDetailAllowUrls: []`) | the UI renders credentials as plain text; pinning survives SDK default changes |

## Source maps + releases (image builds)

Unlike the deployer (built directly on the VM), the console ships as a Docker image, so source-map upload runs **inside the image's `next build`**. The [`console/Dockerfile`](../console/Dockerfile) builder stage takes `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_RELEASE` as build args and `SENTRY_AUTH_TOKEN` as a BuildKit secret (`--mount=type=secret,id=sentry_auth_token` — never baked into a layer); `withSentryConfig` uploads the artifact bundle when the token is present.

Two build drivers feed those in, both fail-soft (missing secret → build proceeds, upload skipped):

1. **Laptop sideload** ([`scripts/build-console-image.sh`](../scripts/build-console-image.sh)) — the path that reaches the **Pyramid bare-metal** node (it runs a locally-built `console.local:<hash>` image, not GHCR). Pulls `isv-labs-sentry-build-env` from Secret Manager, sets `SENTRY_RELEASE` to the image tag hash, passes `--build-arg` + `--secret` to `docker buildx build`.
2. **CI GHCR build** ([`.github/workflows/build-console.yml`](../.github/workflows/build-console.yml)) — authenticates to GCP via WIF (fail-soft), fetches the same secret, and passes `build-args` + `secrets` to `docker/build-push-action`. `SENTRY_RELEASE` = the pushed short SHA (matches the image tag).

`SENTRY_PROJECT` is hardcoded to `scality-vss-console-ui` in both drivers (the shared secret's `SENTRY_PROJECT=isv-deployer` is the deployer's); only the org + auth token are reused.

## Deploying Sentry to a running instance (e.g. Pyramid)

Pyramid runs a sideloaded image with no Sentry env today. To turn it on:

```bash
# 1. Rebuild + sideload the console image (source maps upload if the secret is present)
scripts/build-console-image.sh
scripts/deploy-console.sh          # applies manifests + rolls the pod

# 2. (optional) point at a specific DSN without a rebuild — DSN is not a secret
kubectl -n console patch cm console-env --type merge \
  -p '{"data":{"SENTRY_DSN":"<dsn>","NEXT_PUBLIC_SENTRY_DSN":"<dsn>"}}'
kubectl -n console rollout restart deploy/console
```

Once the DSN fallback is inlined in the config files, step 2 is unnecessary — the pod reports as soon as the new image runs.

## Verifying the pipeline end to end

`GET /api/sentry-verify` ([`console/src/app/api/sentry-verify/route.ts`](../console/src/app/api/sentry-verify/route.ts)) throws a deliberate unhandled error. The console pod is reachable only over the SG-restricted `:8800` hostPort.

```bash
# trigger from inside the console pod
kubectl -n console exec deploy/console -- curl -s -o /dev/null -w "%{http_code}\n" \
  http://localhost:8800/api/sentry-verify
```

Then open the newest `sentry-verify: deliberate test error` issue and check the top in-app frame reads `src/app/api/sentry-verify/route.ts` with the original TypeScript source (minified `chunks/*.js` paths mean the source-map upload failed — check the secret and the build log for the `Sentry source-map upload enabled` line), and that `release` matches the deployed image tag.

## API access with the CI token

The org auth token (`sntrys_…`) is CI-scoped: it uploads source maps and reads releases/artifact bundles but returns 403 on project/issue/event endpoints (confirmed — it cannot read the project's client keys, so the DSN must be obtained from the Sentry UI or the setup wizard). Reading event frames programmatically needs a personal token with `event:read`; otherwise verify in the UI.
