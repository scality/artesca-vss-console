# The config store

The console's runtime configuration — cameras, the VLM prompt-sets, alert scenarios, and the reconciler's last status — lives in a **config store**, behind the `ConfigStore` interface in [`src/lib/config-store/types.ts`](../src/lib/config-store/types.ts). Two backends implement it.

| Backend | Selected by | Where the data is |
| --- | --- | --- |
| **YAML file** (default) | `CONSOLE_CONFIG_STORE=file`, or nothing set | `$CONSOLE_DATA_DIR/config-store/<instance>.yaml` |
| Firestore | `CONSOLE_CONFIG_STORE=firestore` | `instances/<instance>` + its `cameras` / `scenarios` / `prompts` subcollections |

The file store is the default so that running this console needs nothing but a volume. Firestore requires a GCP project, a service-account key and a `datastore.user` grant, none of which anyone outside the Scality labs has — and the store held the console's *own* configuration, so without a GCP account the operator UI had no working persistence at all.

Nothing calls a backend directly. `makeConfigStore()` in [`src/lib/config-store/index.ts`](../src/lib/config-store/index.ts) resolves the selection; `/about` reports which one answered and what it holds.

**Three surfaces name the backend, and all three take the name from `STORE_LABEL`** in that module: the `/about` panel, the Diagnostics row, and the Overview reachability strip (via `configStoreLabel()`). That row was the literal `"Config store (Firestore)"` and stayed so after pyramid-showroom migrated and deleted its GCP credential — reading `Config store (Firestore) — ok`, green, because the probe goes through `makeConfigStore()` and was correctly reporting a healthy YAML file under the name of a service the pod cannot reach. Nothing failed; the page simply named the wrong system, and the camera and scenario tables' "where do I look" hint sent an operator to it. Those two hints now say only *Diagnostics → Config store*, because they are client components and the label helper sits beside the two `server-only` store modules.

## Unset is not the same as `file`

With `CONSOLE_CONFIG_STORE` unset **and `FIRESTORE_PROJECT_ID` set**, the console selects Firestore and says so on `/about`.

That inference is the one thing standing between this change and a lost lab. Every instance deployed before this existed has its cameras, prompt-sets and scenarios in Firestore, the lab deploy writes `FIRESTORE_PROJECT_ID` into `console-env`, and the ordinary way to ship a new console build to a running lab is:

```bash
kubectl set image deployment/console console=ghcr.io/scality/artesca-vss-console:sha-<x> -n console
```

which does not touch the ConfigMap. A flat default of `file` would bring that pod up on an empty YAML document: no cameras, no prompt-sets, no scenarios, **no error**, and a reconciler that converges the cluster onto nothing.

The inference reads `FIRESTORE_PROJECT_ID` only, never `GOOGLE_CLOUD_PROJECT` — the second is ambient on GCP infrastructure and says nothing about what anyone chose.

Set the variable explicitly on anything new. `/about` flags an inferred selection in amber, because nobody chose it.

## The file layout, and why it is one file

One file per instance, holding every entity kind:

```yaml
schema: isv-labs.console-config.v1
instance: ap-vss-val-4
updatedAt: 2026-08-12T20:14:03.221Z
updatedBy: operator@scality.com
activePromptId: default
cameras:
  - id: lobby
    rtspUrl: rtsp://camera-sim:8554/lobby
    scenarioIds: [loitering]
    updatedBy: operator@scality.com
    updatedAt: 2026-08-12T20:14:03.221Z
scenarios:
  - id: loitering
    name: Loitering
    severity: medium
    channels: [ui]
    sensor_filter: "*"
    keywords: [loiter]
    enabled: true
promptSets:
  - id: default
    name: Default
    text: Describe what you see.
```

An operator reads, diffs, copies or hands over an instance's whole configuration as a single artifact — the property a directory of six files does not have. The cost is that **every write is a read-modify-write of one file**, which is what makes the locking below load-bearing rather than defensive.

## Two pods write it

This is the fact that shapes the implementation, and it is easy to get wrong by looking only at `k8s/`:

- The **console** pod serves the UI: camera upserts, prompt-set edits, scenario writes. It also fires one startup convergence pass on every boot, which writes a `reconcileStatus` — `CONSOLE_DISABLE_RECONCILE_LOOP=1` suppresses only the *periodic* loop.
- The **reconcile-agent** pod (manifests are Scality-lab-internal) runs the same image with `RECONCILE_AGENT=1`, and writes a `reconcileStatus` on every tick plus a one-shot prompt-set seed at boot.

So there are always two writers, never one. `FileConfigStore` serialises them with a lock file (`O_CREAT|O_EXCL` beside the data, reclaimed by age after 30 s) and replaces the document with an atomic temp-and-rename, so a reader sees the old file or the new one and never a half-written mapping. An in-process mutex would not reach across pods.

⚠ **`CONSOLE_DATA_DIR` must therefore be a volume every writer mounts.** On a container filesystem each pod gets its own private copy, silently: the console shows the operator's cameras and the agent converges the cluster from an empty store it seeded itself.

## `upsert` replaces the whole entity

Not a field merge. Firestore's `set()` without `{merge:true}` overwrites the document, and [`src/app/api/cameras/[id]/route.ts`](../src/app/api/cameras/[id]/route.ts) depends on it: unbinding a prompt or clearing a scenario override is expressed by `delete`ing the key from the object it then upserts.

Two fields make this observable rather than academic:

- **`promptId`** — absent means the camera is not driven through the realtime API. Merged, "unbind" is a silent no-op and the camera keeps being driven while the UI shows it unbound.
- **`scenarioIds`** — tri-state. Absent means the scenario's own `sensor_filter` glob decides; `[]` means suppress everything; a list means exactly those. A merge cannot distinguish absent from empty, and `setIn(…, undefined)` writes `null`, which then fails validation on every subsequent read.

[`tests/unit/config-store-contract.test.ts`](../tests/unit/config-store-contract.test.ts) runs one suite against **both** backends for exactly this reason — the store is swapped by an environment variable on a live showroom, so a difference in semantics shows up as an operator's edit doing something else after a redeploy, with nothing failing. Mutating `upsertCamera` to a field merge fails the two tests above and nothing else, which is what makes them worth having.

## A corrupt file fails loudly; a missing one does not

A file that is absent means a fresh instance, and reads as empty — the same answer Firestore gives for an instance with no documents.

A file that exists and does not parse, or whose shape is wrong, **throws**. Reading it as empty would present a configured instance as a blank one, and the reconciler would then converge the cluster onto nothing. Validation checks structure, not membership: an entity list must be a list of mappings each carrying a string `id`, and unknown fields pass through untouched, so a newer console's extra field does not make the store unreadable to an older pod.

## The Firestore SDK is an optional install

`@google-cloud/firestore` is in no dependency field. Not for licensing reasons — it is Apache-2.0 — but because the default backend is a file, and a default clone would otherwise pull a GCP client library, gRPC and protobufjs to run code paths it never reaches. Measured: **208 packages, 133 → 49 in the production tree.**

It stays available rather than being deleted, because it is where every existing lab's data still is and it is the rollback path if the file store turns out to be wrong on a live showroom.

- Locally: `npm run enable-firestore`
- In an image: `--build-arg WITH_FIRESTORE=1` — which CI passes, so every published image can serve either backend
- Absent, `CONSOLE_CONFIG_STORE=firestore` refuses at startup with a message naming the flag

The presence check is [`firestore-optional.cjs`](../firestore-optional.cjs), read by both `next.config.js` and `vitest.config.ts` so the resolvers cannot disagree. Same arrangement as the telemetry SDK — see [`console-sentry.md`](console-sentry.md) — and one measured detail is worth keeping: being listed in `serverExternalPackages` is **not** enough on its own. With the package absent, `next build` still fails to resolve the dynamic `await import()`, so the specifier is aliased to a refusing stub and dropped from the externals list.

## Migrating a lab off Firestore

The copy runs **inside the pod**, via [`/api/config-store/migrate`](../src/app/api/config-store/migrate/route.ts) — the only place with both the Firestore SDK and the `console-data` volume.

```bash
# 1. dry run — reports both sides, writes nothing
kubectl -n console exec deploy/console -- \
  curl -sS -XPOST localhost:8800/api/config-store/migrate

# 2. copy
kubectl -n console exec deploy/console -- \
  curl -sS -XPOST 'localhost:8800/api/config-store/migrate?apply=1'

# 3. check /about reports the counts you expect, THEN cut over
kubectl -n console patch cm console-env --type merge \
  -p '{"data":{"CONSOLE_CONFIG_STORE":"file"}}'
kubectl -n console rollout restart deploy/console deploy/reconcile-agent

# 4. only once /about names the file backend AND reports the counts: drop the
#    credential. This is the step that actually removes the GCP dependency —
#    everything above merely stops reading it.
kubectl -n console delete secret config-store-rw
```

Four things about it that are deliberate:

- **It reads Firestore directly**, not through `makeConfigStore()`. That factory returns whichever backend is selected, so after a cutover it would copy the file store onto itself and report success.
- **It does not switch the backend.** Changing the ConfigMap restarts the pod, so doing both would migrate and cut over in one step with no interval in which to look at the result.
- **It refuses a non-empty destination** (409) unless `&force=1`. Once the cutover has happened the file store is live, and re-running would replace real edits with a Firestore copy that is stale by definition.
- **It reads back through the validator** and fails if the counts differ or the schema is unrecognised. A write that produced a file the reader then refuses to parse is the one outcome that must not report success.

The in-pod `curl` reaches the route unauthenticated only because `k8s/11-configmap-env.yaml` sets `CONSOLE_DISABLE_AUTH: "true"` — the same dependency `/api/sentry-verify` has. On a pod with the sign-in gate on, the request is redirected to `/sign-in` with a `307` and nothing happens.

Rolling back is the reverse and needs no migration, because the copy leaves Firestore untouched: set `CONSOLE_CONFIG_STORE=firestore` and restart. After step 4 a rollback also has to recreate the secret, so leave the credential in place for as long as you want a one-command rollback — steps 3 and 4 are deliberately separate for that reason.

## What removes the GCP dependency, and what only stops using it

Cutting over is not the same as weaning off GCP, and only one of these three is the credential actually leaving the cluster:

| Change | Effect |
| --- | --- |
| `CONSOLE_CONFIG_STORE=file` | the console stops *reading* GCP. The SA key is still mounted, still valid, and still grants `datastore.user` to anything that can exec into the pod |
| `kubectl delete secret config-store-rw` | the credential is gone. `kubectl get secrets -A \| grep -c config-store` returning `0` is the proof |
| the secret volume being `optional: true` | what makes the line above *possible*. kubelet will not start a container that references a missing secret, so before this the credential could not be removed from a running instance at all |

The last one is why `k8s/20-console.yaml` marks the volume optional even though every Scality lab currently provisions the secret: without it, "migrate to the file backend" ends at a pod that reads no GCP and still cannot start without a GCP key.

On the deploy side, `deploy-console.sh` fetches that key from Secret Manager **only when the resolved backend is `firestore`**. That is the single `gcloud` call on the console deploy path, so an instance on the file backend deploys with no GCP project, no `gcloud` on `PATH` and no Secret Manager grant — which was the point of making the file store the default. It used to run unconditionally, which made `gcloud` a hard prerequisite of deploying a console that would never read the key.
