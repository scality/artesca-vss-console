# Security policy

## Reporting a vulnerability

**Do not open a public issue.** Report privately through GitHub:

> **Security** tab → **Report a vulnerability**
> <https://github.com/scality/artesca-vss-console/security/advisories/new>

The report is visible only to the maintainers of this repository until an advisory
is published. Include the version or commit you tested, how the issue is reached,
and what an attacker gains from it.

Reports are acknowledged on a best-effort basis. There is no guaranteed response
window; if the finding affects a deployment that is live, say so in the report.

## Supported versions

`main` is the only supported branch. There are no tagged releases and no
backports — images are published per commit as
`ghcr.io/scality/artesca-vss-console:sha-<short-sha>`, alongside `:latest`.

That package is currently private, so **name a commit rather than an image tag** in
a report, and build from source with the [`Dockerfile`](Dockerfile) in this
repository — the one CI uses. A finding pinned only to a tag that the reader
cannot fetch cannot be reproduced.

## Known limitations of a default deployment

These are properties of the code as published, not vulnerabilities to report. Each
is tracked as an issue, linked below — so "known" is checkable rather than a claim
this file makes about itself. They are listed here because a reference
implementation is copied, and copying these without reading them is the actual
risk:

- **Authentication is a single shared password** ([#7](https://github.com/scality/artesca-vss-console/issues/7)). `CONSOLE_PASSWORD` is one
  credential shared by everyone who opens the console. There is no per-user
  identity, so the audit log records that an action happened and not who took it.
- **One credential can be revealed on request, and secret material reaches
  server-side frame locals** ([#8](https://github.com/scality/artesca-vss-console/issues/8)). The Grafana password is no longer part of the
  overview's page payload: the card
  ([`src/components/overview/GrafanaAccessCard.tsx`](src/components/overview/GrafanaAccessCard.tsx))
  fetches it from `POST /api/grafana-credential`, which requires a session and
  audits the reveal. **The residual exposure is that "a session" means the single
  shared password above**, so anyone who can open the console can reveal it, and
  the audit line cannot say who did. Once revealed it is selectable text in the
  DOM. `/cameras` shows the S3 access key **id** in its chain diagnosis.
  Server-side, the routes that report whether a secret is configured read the
  stored value to do it, so it is live in a stack frame. This is why Sentry replay
  masking is pinned on and `includeLocalVariables` is off.

  The Secrets page is **not** part of this: `GET /api/secrets/<key>` returns
  `{ key, configured, ageMs }` — a boolean and an age, never a value — and
  rotation is write-only. This bullet claimed otherwise until 2026-08-13; it was
  wrong, and it is called out rather than quietly edited because a policy that
  overstates is no more usable than one that understates.
- **The console can execute commands in the workload pods.** `k8s/01-rbac.yaml`
  is read-only and cluster-scoped; the `console-exec` Role in
  `k8s/02-workload-rbac.yaml.example` grants `pods/exec` in the VSS namespace
  alone. Four observability probes need it — `df` on the recording cache,
  `pg_isready` and two `psql` counts, `redis-cli ping`/`info` — but the grant is
  arbitrary command execution in those pods, including a shell that can read
  their environment. Omit the Role if you can live without those figures; the
  console runs without it and reports them as unknown.
- **Secret writes are pinned, secret reads in the workload namespace are not.**
  Rotation is restricted by `resourceNames` to the Secrets the `/secrets` page
  actually rotates. The `get` in a workload namespace is deliberately unpinned,
  because the LLM health probe follows whatever `secretKeyRef` a container
  declares and cannot know the name in advance — so the console can read any
  Secret in that namespace. Drop the rule if that matters more than the probe.

Do not expose the console to an untrusted network. It is built to run inside a
cluster, reached by operators.

## Telemetry

Error reporting is off unless a DSN is configured, and the SDK is not installed
unless you opt in (`npm run enable-telemetry`, or `--build-arg WITH_TELEMETRY=1`).
No DSN ships in this tree, so a build made from it reports nowhere by default.
