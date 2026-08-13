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

## Known limitations of a default deployment

These are properties of the code as published, not vulnerabilities to report. Each
is tracked as an issue. They are listed here because a reference implementation is
copied, and copying these without reading them is the actual risk:

- **Authentication is a single shared password.** `CONSOLE_PASSWORD` is one
  credential shared by everyone who opens the console. There is no per-user
  identity, so the audit log records that an action happened and not who took it.
- **Credentials are rendered and logged in clear.** The Secrets page displays
  secret values, the Grafana password is shown in clear on the overview, and
  cluster command lines are written to the logs with their arguments. This is why
  Sentry replay masking is pinned on and `includeLocalVariables` is off.
- **The Kubernetes RBAC is broad.** `k8s/console/01-rbac.yaml` requests `get` and
  `create` on `pods/exec` and `get`, `list`, `patch` on secrets, in addition to
  the read verbs. Scope it down to the features you actually deploy.

Do not expose the console to an untrusted network. It is built to run inside a
cluster, reached by operators.

## Telemetry

Error reporting is off unless a DSN is configured, and the SDK is not installed
unless you opt in (`npm run enable-telemetry`, or `--build-arg WITH_TELEMETRY=1`).
No DSN ships in this tree, so a build made from it reports nowhere by default.
