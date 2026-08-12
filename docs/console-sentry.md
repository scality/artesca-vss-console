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

**The SDK itself is an optional install.** `@sentry/nextjs` is in no dependency field of `package.json`: it pulls `@sentry/cli` under FSL-1.1-MIT, source-available rather than open source, and this repository is public. A default clone installs zero FSL packages (measured: 2 with it declared, 0 without).

Opt in locally with `npm run enable-telemetry`, and in an image with `--build-arg WITH_TELEMETRY=1` — which CI and `isv-labs:scripts/build-console-image.sh` both pass, so every lab image reports. Without it the specifier is aliased to a no-op module and the app runs with reporting compiled out, whatever `SENTRY_DSN` says. Package absence and DSN absence are separate states, and `/about` shows the second one.

`telemetry-optional.cjs` holds the presence check that `next.config.js` and `vitest.config.ts` both read; `src/lib/telemetry.ts` is the only module that names the package.

**There is no DSN in the source tree, and telemetry does nothing without one.** [`src/lib/telemetry-config.ts`](../src/lib/telemetry-config.ts) is the single reader for all three runtimes, and each `Sentry.init` is guarded on a configured value — an undefined `dsn` would install the SDK's handlers and then drop every event, which is indistinguishable from working telemetry in a log.

Supply it from the deployment: `SENTRY_DSN` for server and edge, via the `console-env` ConfigMap; `NEXT_PUBLIC_SENTRY_DSN` for the browser, which Next inlines at build time and a ConfigMap therefore cannot reach. `isv-labs:scripts/deploy-console.sh` fills the first for the Scality labs, so a lab pod reports as soon as it is redeployed. A DSN is an ingest-only identifier rather than a credential — the reason it is not in the tree is that a compiled-in default sends someone else's build into our project (ISVD-607).

## What's instrumented

- **Errors**: unhandled server route errors (`onRequestError` in [`console/src/instrumentation.ts`](../console/src/instrumentation.ts)), root-layout React errors ([`console/src/app/global-error.tsx`](../console/src/app/global-error.tsx)), browser errors.
- **Tracing**: 100% sampled in dev, 10% in production, on every runtime.
- **Session replay**: 10% of sessions, 100% of error sessions — fully masked (see below).
- **Tunnel**: browser events proxy through the app at `/monitoring` (`tunnelRoute` in [`console/next.config.js`](../console/next.config.js)) so ad-blockers don't drop them.

Init files: [`console/src/instrumentation-client.ts`](../console/src/instrumentation-client.ts) (browser), [`console/sentry.server.config.ts`](../console/sentry.server.config.ts) (Node), [`console/sentry.edge.config.ts`](../console/sentry.edge.config.ts) (edge), loaded from [`console/src/instrumentation.ts`](../console/src/instrumentation.ts) ahead of the background watchers/reconcile loop. Each one imports the SDK through `src/lib/telemetry.ts` and guards its `init` on a configured DSN, so a build with no SDK and a deploy with no DSN both end up silent rather than half-initialised.

## Secret-leak hardening — the constraints that must hold

The console holds lab secrets (objectstore/S3 keys, the camera-sim SSH PEM, the Firestore SA key) in server-side locals, logs cluster command lines, and renders credentials as text (Grafana/Keycloak passwords on Overview, the Secrets page, S3 endpoint keys). Three SDK features are therefore deliberately off / pinned, and **must stay that way when anyone adds a Sentry signal later**:

| Setting | State | Why |
| ------- | ----- | --- |
| `includeLocalVariables` | off (server) | frame locals routinely hold key material |
| `enableLogs` | off (all runtimes) | forwarded console/log lines carry cluster command lines and fetched secret state |
| Replay masking | pinned explicit (`maskAllText`, `maskAllInputs`, `blockAllMedia`, `networkDetailAllowUrls: []`) | the UI renders credentials as plain text; pinning survives SDK default changes |

## Source maps + releases (image builds)

Unlike the deployer (built directly on the VM), the console ships as a Docker image, so source-map upload runs **inside the image's `next build`**. The [`Dockerfile`](../Dockerfile) builder stage takes `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_RELEASE` as build args and `SENTRY_AUTH_TOKEN` as a BuildKit secret (`--mount=type=secret,id=sentry_auth_token` — never baked into a layer); `withSentryConfig` uploads the artifact bundle when the token is present.

Two build drivers feed those in, both fail-soft (missing secret → build proceeds, upload skipped):

1. **Laptop sideload** (`isv-labs:scripts/build-console-image.sh`) — the path that reaches the **Pyramid bare-metal** node (it runs a locally-built `console.local:<hash>` image, not GHCR). Pulls `isv-labs-sentry-build-env` from Secret Manager, sets `SENTRY_RELEASE` to the image tag hash, passes `--build-arg` + `--secret` to `docker buildx build`. Only reachable in `CONSOLE_SOURCE_MODE=source`, i.e. with a checkout of this repository beside isv-labs; in `pull` mode the node runs the CI image below.
2. **CI GHCR build** ([`.github/workflows/build-console.yml`](../.github/workflows/build-console.yml)) — authenticates to GCP via WIF (fail-soft), fetches the same secret, and passes `build-args` + `secrets` to `docker/build-push-action`. `SENTRY_RELEASE` = the pushed short SHA (matches the image tag).

`SENTRY_PROJECT` is hardcoded to `scality-vss-console-ui` in both drivers (the shared secret's `SENTRY_PROJECT=isv-deployer` is the deployer's); only the org + auth token are reused.

## Deploying Sentry to a running instance (e.g. Pyramid)

Pyramid runs a sideloaded image with no Sentry env today. To turn it on:

```bash
# 1. Rebuild + sideload the console image (source maps upload if the secret is present)
#    Both live in isv-labs; deploy-console.sh calls the builder itself.
isv-labs:scripts/deploy-console.sh --instance pyramid-showroom

# 2. point the pod at a DSN. deploy-console.sh already does this for the labs;
#    do it by hand after a `kubectl set image`, which does not touch the ConfigMap.
#    NEXT_PUBLIC_SENTRY_DSN is inlined at build time — setting it here does
#    nothing for the browser bundle, only a rebuild can.
kubectl -n console patch cm console-env --type merge \
  -p '{"data":{"SENTRY_DSN":"<dsn>"}}'
kubectl -n console rollout restart deploy/console
```

Step 2 is required, not optional: the image carries no DSN, so a pod with no
`SENTRY_DSN` in its ConfigMap reports nothing at all. `/about` is where to check
— it names the Sentry state alongside the config store's.

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
