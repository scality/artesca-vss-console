## What this changes

<!-- One or two sentences. What behaviour is different after this lands. -->

## Why

<!-- The problem. Link the issue: `Closes #12` / `Issue: #12`. -->

## How it was verified

<!--
What you ran, and what it said. "Tests pass" is not verification unless the tests
cover the change — name them. If it needs a cluster and you have not had one, say
so; an unverified change is fine to open, an unverified change described as
verified is not.
-->

## Checklist

- [ ] Tests cover the change (`tests/unit` for logic, `tests/e2e` for UI)
- [ ] `npm run lint`, `npm test` and `npm run build` pass locally
- [ ] Documentation updated where the change makes it wrong (`README.md`,
      `docs/`, `CLAUDE.md`)
- [ ] No credentials, tokens, internal hostnames or customer names in the diff
