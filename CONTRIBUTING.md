# Contributing

## Where issues are tracked

**GitHub Issues on this repository is the tracker.** Bugs, feature requests and
questions all go there: <https://github.com/scality/artesca-vss-console/issues>.

Two things follow from that, and they are the whole convention:

- **Nothing is tracked anywhere a reader of this repository cannot see.** If work
  on the console is planned, in progress or refused, the issue says so here.
- **A vulnerability is the one exception** and does not go in an issue at all —
  see [SECURITY.md](SECURITY.md).

### The `ISVD-…` references in the code and the git history

Comments, tests and commit footers across this repository cite keys like
`ISVD-506` or `ISVD-607`. Those belong to Scality's internal issue tracker, which
is **not publicly readable**. They are kept because they record which change a
piece of code came from, and that provenance is worth more than a tidy tree — but
they are not links you can follow, and no work is tracked there that this
repository's issues do not describe. Read them as historical markers.

New work is referenced the ordinary way: `Issue: #<number>` in the commit footer,
pointing at an issue on this repository.

## Scope

The console is an operator UI for one stack: NVIDIA VSS running on Kubernetes
with Scality ARTESCA as the object store. It assumes the cluster is up and the
VSS services are deployed; it does not install or provision anything.

Questions about the VSS blueprint itself, its models or its APIs belong upstream
with NVIDIA. Questions about ARTESCA belong with Scality. What belongs here is
the console: its pages, its API routes, its Kubernetes manifests and how it reads
the stack.

Parts of the tree still assume the Scality lab — hardcoded namespaces and service
names in `src/lib/cluster-refs.ts`, and AWS EC2 code paths that exist to drive a
lab instance. Those are known and tracked as issues; a report that the console
does not start against a differently-named deployment is useful, not a duplicate
of something obvious.

## Development

Node 24 (what the image and CI both build with).

```bash
npm install
npm run dev          # http://localhost:5003
```

The app starts with nothing configured. Missing `KAFKA_BROKERS`, `REDIS_URL` or
`CAMERA_SIM_HOST` render as degraded or disconnected states rather than crashing,
so a great deal can be worked on without a cluster. Copy `.env.example` to
`.env.local` and fill in what your change needs.

```bash
npm run lint         # eslint src
npm test             # vitest
npm run test:e2e     # playwright
npm run build        # next build
```

`npm run test:e2e` needs a built Monaco under `public/monaco/vs`; the `pretest:e2e`
hook copies it. `postinstall` deliberately does not, because the Dockerfile
installs with `--ignore-scripts`.

### Secrets

Nothing that authenticates anything belongs in a commit — a credential in the
history is removed by rewriting it, not by reverting it. [`.gitleaks.toml`](.gitleaks.toml)
configures a scan for that:

```bash
gitleaks git --staged -v --no-banner .   # before you commit
gitleaks git -v --no-banner .            # the whole history
```

The three matches this repository's history contains are fabricated — a fake
Kubernetes Secret the smoke test creates, and the jwt.io example token a
redaction test asserts against — and are allowlisted individually by value, so a
real one is still caught.

## Pull requests

- Branch from `main` and open the PR against `main`.
- CI (`build-console`) runs lint, unit tests, E2E and the build on every PR that
  touches the relevant paths. It must pass. A PR that changes only paths outside
  that list runs nothing — say so in the description rather than letting a green
  checkmark that never ran stand in for a test.
- Keep the change focused. A refactor bundled with a fix makes both harder to
  review and harder to revert.
- Tests belong with the change. `tests/unit` for logic, `tests/e2e` for anything
  an operator clicks.

### Commit messages

Conventional-commit subjects — `feat(scope):`, `fix(scope):`, `chore(scope):`,
`test(scope):`, `docs(scope):`, `ci:`. One logical change per commit. Reference
the issue in a footer:

```text
fix(incidents): keep the SSE backlog when the stream reconnects

Issue: #12
```

## Response times

This console is maintained alongside other work. Issues and pull requests are
read and triaged on a best-effort basis — there is no support commitment, and an
issue staying open is not a decision against it. If something is urgent for a
deployment you run, say so in the issue.

## Code of conduct

Participation is governed by the [Contributor Covenant](CODE_OF_CONDUCT.md) 2.1.
It names a real address to report to, which is the half of that document that
matters.

## Licence

Contributions are accepted under the [Apache License 2.0](LICENSE), the licence
this project is distributed under.
