#!/usr/bin/env python3
"""Report a red — or unverified — build-console run by email.

The console's CI is a GitHub Actions workflow, and nothing surfaced a failure:
main was red for at least a day and the work continued on top of it, which is
how a second failure hid behind the first (ISVD-577). The rest of the ISV fleet
alerts from the VM, where a failing unit emails NOTIFY_TO through a systemd
OnFailure handler. This repository has no VM, and it cannot send from inside the
workflow either: `scality/artesca-vss-console` is absent from the `github-pool`
WIF allowlist and the repository has no Actions secrets, so a job here can reach
neither Secret Manager nor the Gmail token. Until that changes, the alarm runs
laptop-side, which is also where the sizer's board report runs.

Mail goes through isv-portal backend/scripts/notify.py — the fleet's one subject
grammar and X-ISV-Alert routing header, sent on the workspace-mcp OAuth token
rather than anything touching gcloud (a gcloud-dependent alert path goes silent
exactly when the Workspace reauthentication policy is the thing to report).

Four states are worth an email, and the third is the one a "did the run fail"
check misses:

  failure     the run completed red
  unverified  the run was cancelled with nothing executed, or HEAD has no run
              at all and no ancestor's run covers it (see `covered` below).
              GitHub Actions was in major_outage on 2026-08-06 and every push
              for seven consecutive commits created no run, so a check that
              only looks at the newest run's conclusion reports the last
              green one and says main is fine.
  covered     HEAD has no run of its own, but `build-console.yml`'s `paths:`
              filter means it wouldn't have created one anyway — none of the
              files changed since the newest ancestor commit that DOES have a
              completed run touch a build input (ISVD-style CLAUDE.md-only
              commits are the common case). HEAD inherits that ancestor's
              conclusion: a passing base reads as green, a failing one still
              alerts. Without this, a docs-only commit reads as `unverified`
              and pages for 39+ hours over a run the workflow was never going
              to create (measured on d2fecc9, 2026-09-23..25).
  recovered   the first success after `failure`, `unverified`, or a
              base-failed `covered`

Mail discipline follows deploy/vm/stall-check.py in isv-portal: only a NEW
condition mails, recovery mails once, and the state file survives a reboot, so
a laptop that wakes to a week-old failure does not open with a digest of things
already read.

Usage:
  ci-alert.py                 # poll once, mail on a state change
  ci-alert.py --dry-run       # print what it would send, touch no state
  ci-alert.py --selftest      # exercise the classifier, no network
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = "scality/artesca-vss-console"
WORKFLOW = "build-console.yml"
BRANCH = "main"
NOTIFY = Path.home() / "Developer/scality/isv-portal/backend/scripts/notify.py"
WORKFLOW_FILE = Path(__file__).resolve().parent.parent / ".github/workflows/build-console.yml"

# How far back to walk main's history looking for an ancestor commit that has
# a completed build-console run, when HEAD itself has none.
COVERAGE_LOOKBACK = 20

STATE_DIR = Path.home() / "Library/Application Support/Scality/state"
STATE_FILE = STATE_DIR / "console-ci.json"
STATUS_DIR = Path(
    os.environ.get("SR_STATUS_DIR", Path.home() / "Library/Application Support/Scality/logs")
)

# How long HEAD may sit without a run before that is itself the alert. A run
# normally appears within seconds; this is slack for a queue, not for an outage.
NO_RUN_GRACE = timedelta(minutes=45)


def gh_json(args: list[str]) -> object:
    out = subprocess.run(
        ["gh", *args], capture_output=True, text=True, timeout=120, check=False
    )
    if out.returncode != 0:
        raise RuntimeError(f"gh {' '.join(args)} failed: {out.stderr.strip()[:300]}")
    return json.loads(out.stdout or "null")


def load_push_paths(workflow_path: Path = WORKFLOW_FILE) -> list[str]:
    """Read `on.push.paths` out of the checked-out workflow file.

    A hand-rolled block-YAML walk, not a YAML parser: it tracks indentation to
    find the `on:` map, then `push:` inside it, then the `paths:` list inside
    that, and collects `- "..."` items until indentation drops back out of the
    list. Good enough for this one file's style (block mappings, quoted
    strings, `#` comments) without adding a PyYAML dependency this script
    doesn't otherwise need.
    """
    lines = workflow_path.read_text().splitlines()
    state = "seek_on"  # seek_on -> seek_push -> seek_paths -> in_paths
    on_indent = push_indent = paths_indent = None
    paths: list[str] = []
    for raw in lines:
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))

        if state == "seek_on":
            if stripped == "on:":
                state, on_indent = "seek_push", indent
            continue

        if state == "seek_push":
            if indent <= on_indent:
                break  # left the `on:` map without finding `push:`
            if stripped == "push:":
                state, push_indent = "seek_paths", indent
            continue

        if state == "seek_paths":
            if indent <= push_indent:
                break  # left `push:` without finding `paths:`
            if stripped == "paths:":
                state, paths_indent = "in_paths", indent
            continue

        if state == "in_paths":
            if indent <= paths_indent:
                break
            if stripped.startswith("- "):
                item = stripped[2:].strip()
                if len(item) >= 2 and item[0] == item[-1] and item[0] in "\"'":
                    item = item[1:-1]
                paths.append(item)
    return paths


def glob_to_regex(pattern: str) -> re.Pattern:
    """Translate one GitHub Actions `paths:` glob into a regex.

    Not a full picomatch port — covers what this workflow's list actually
    uses: literal segments, `dir/**` (zero or more path segments under
    `dir`), a leading `**/`, and `*`/`?` within a single segment (never
    crossing `/`).
    """
    out: list[str] = []
    i, n = 0, len(pattern)
    while i < n:
        if pattern[i : i + 3] == "**/":
            out.append("(?:.*/)?")
            i += 3
        elif pattern[i : i + 3] == "/**" and i + 3 == n:
            out.append("(?:/.*)?")
            i += 3
        elif pattern[i : i + 2] == "**" and i + 2 == n:
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("^" + "".join(out) + "$")


def matches_any(paths_globs: list[str], changed_files: list[str]) -> list[str]:
    """Changed files that match at least one `paths:` glob."""
    compiled = [glob_to_regex(p) for p in paths_globs]
    return [f for f in changed_files if any(rx.match(f) for rx in compiled)]


def find_covered_base(head_sha: str) -> tuple[str | None, dict | None, list[str] | None]:
    """Walk main's history behind HEAD for the newest ancestor with a completed
    build-console run, and the files changed between it and HEAD.

    Returns (base_sha, base_run, changed_files); any element is None when the
    lookback found nothing usable or an API call failed. Network only — no
    local `git`, since the LaunchAgent's checkout may lag behind what actually
    ran in Actions.
    """
    try:
        shas = gh_json(
            [
                "api",
                f"repos/{REPO}/commits",
                "-f",
                f"sha={head_sha}",
                "-f",
                f"per_page={COVERAGE_LOOKBACK + 1}",
                "--jq",
                "[.[].sha]",
            ]
        )
    except RuntimeError:
        return None, None, None
    if not isinstance(shas, list) or len(shas) < 2:
        return None, None, None

    for base_sha in shas[1:]:
        try:
            run = gh_json(
                [
                    "api",
                    f"repos/{REPO}/actions/workflows/{WORKFLOW}/runs",
                    "-f",
                    f"head_sha={base_sha}",
                    "-f",
                    "per_page=1",
                    "--jq",
                    ".workflow_runs[0] // empty | "
                    "{databaseId:.id,headSha:.head_sha,conclusion:.conclusion,status:.status}",
                ]
            )
        except RuntimeError:
            continue
        if not run or run.get("status") != "completed" or run.get("conclusion") in (None, ""):
            continue
        try:
            changed = gh_json(
                ["api", f"repos/{REPO}/compare/{base_sha}...{head_sha}", "--jq", "[.files[].filename]"]
            )
        except RuntimeError:
            return base_sha, run, None
        return base_sha, run, changed if isinstance(changed, list) else None
    return None, None, None


def resolve_coverage(
    head_sha: str,
    age_min: int,
    base_sha: str | None,
    base_run: dict | None,
    changed_files: list[str] | None,
    paths_globs: list[str],
) -> dict:
    """Decide whether a HEAD with no run of its own is covered by an ancestor's.

    Pure — the network/filesystem lookups happen in `find_covered_base` and
    `load_push_paths`, both callable from `--selftest` fixtures. Falls back to
    the plain `unverified` wording whenever there is nothing usable to reason
    from (no base run found, ancestor's run itself inconclusive, or the diff
    could not be read) — the caller's existing behaviour, unchanged.
    """
    fallback = {
        "state": "unverified",
        "sha": head_sha,
        "detail": f"HEAD has had no run for {age_min} min — a push creates none while "
        f"Actions is degraded, so nothing has checked this commit",
    }
    if base_run is None or base_sha is None or changed_files is None:
        return fallback
    conclusion = base_run.get("conclusion")
    if conclusion in (None, "", "cancelled"):
        return fallback  # an inconclusive base run proves nothing about HEAD either
    if matches_any(paths_globs, changed_files):
        return fallback
    return {
        "state": "covered",
        "sha": head_sha,
        "base_sha": base_sha,
        "base_conclusion": conclusion,
        "run": base_run.get("databaseId"),
        "detail": f"HEAD {head_sha[:7]} changes no build input since {base_sha[:7]}, "
        f"whose run {base_run.get('databaseId')} is {conclusion}",
    }


def _is_bad(cur: dict) -> bool:
    if cur["state"] == "covered":
        return cur.get("base_conclusion") not in ("success",)
    return cur["state"] in ("failure", "unverified")


def _is_green(cur: dict) -> bool:
    if cur["state"] == "covered":
        return cur.get("base_conclusion") == "success"
    return cur["state"] == "green"


def classify(run: dict | None, head_sha: str, head_committed: datetime, now: datetime) -> dict:
    """Decide the current state from the newest run and what HEAD is.

    Pure — every branch is covered by --selftest. `run` is the newest run for
    the workflow on the branch, or None when there is not one at all.
    """
    if run is None or run.get("headSha") != head_sha:
        # The newest run does not describe HEAD. Inside the grace window that is
        # a run still being created; past it, HEAD is unverified.
        if now - head_committed < NO_RUN_GRACE:
            return {"state": "pending", "sha": head_sha, "detail": "run not created yet"}
        age = int((now - head_committed).total_seconds() // 60)
        return {
            "state": "unverified",
            "sha": head_sha,
            "detail": f"HEAD has had no run for {age} min — a push creates none while "
            f"Actions is degraded, so nothing has checked this commit",
        }

    conclusion = run.get("conclusion")
    if conclusion == "success":
        return {"state": "green", "sha": head_sha, "detail": "run passed", "run": run.get("databaseId")}
    if conclusion in (None, ""):
        return {"state": "pending", "sha": head_sha, "detail": "run in progress", "run": run.get("databaseId")}
    if conclusion == "cancelled":
        return {
            "state": "unverified",
            "sha": head_sha,
            "detail": "run was cancelled — during an Actions outage this happens with zero "
            "steps executed, which is not a test failure and not a pass either",
            "run": run.get("databaseId"),
        }
    return {
        "state": "failure",
        "sha": head_sha,
        "detail": f"run concluded {conclusion}",
        "run": run.get("databaseId"),
    }


def failing_step(run_id: int) -> str:
    """Name the step that failed, so the mail says more than 'CI is red'."""
    try:
        jobs = gh_json(["run", "view", str(run_id), "--repo", REPO, "--json", "jobs"])
        for job in (jobs or {}).get("jobs", []):
            for step in job.get("steps", []):
                if step.get("conclusion") == "failure":
                    return f"{job.get('name')} / {step.get('name')}"
    except Exception as e:  # a missing step name must not cost the whole alert
        return f"(could not read steps: {e})"
    return "(no failed step reported — the job died before running one)"


def send(kind: str, summary: str, body: str, dry_run: bool) -> None:
    if dry_run:
        print(f"--- would send ---\n[{kind}] {summary}\n\n{body}\n---")
        return
    subprocess.run([sys.executable, str(NOTIFY), kind, summary, body], check=True, timeout=180)


def write_status(cur: dict, mailed: bool) -> None:
    """The menubar's Background section reads these."""
    STATUS_DIR.mkdir(parents=True, exist_ok=True)
    ok = cur["state"] == "pending" or _is_green(cur)
    (STATUS_DIR / "bg-console-ci.json").write_text(
        json.dumps(
            {
                "id": "console-ci",
                "label": "Console CI",
                "status": "ok" if ok else "failed",
                "detail": f"{cur['state']}: {cur['detail']}",
                "sha": cur["sha"][:7],
                "run_url": f"https://github.com/{REPO}/actions/runs/{cur['run']}"
                if cur.get("run")
                else None,
                "mailed": mailed,
                "checked_at": datetime.now(timezone.utc).isoformat(),
            },
            indent=2,
        )
    )


def selftest() -> int:
    now = datetime(2026, 8, 7, 12, 0, tzinfo=timezone.utc)
    fresh, stale = now - timedelta(minutes=5), now - timedelta(hours=3)
    cases = [
        ("no run, fresh commit", None, fresh, "pending"),
        ("no run, stale commit", None, stale, "unverified"),
        ("run for an older sha", {"headSha": "old", "conclusion": "success"}, stale, "unverified"),
        ("green", {"headSha": "abc", "conclusion": "success"}, fresh, "green"),
        ("red", {"headSha": "abc", "conclusion": "failure"}, fresh, "failure"),
        ("cancelled", {"headSha": "abc", "conclusion": "cancelled"}, fresh, "unverified"),
        ("in progress", {"headSha": "abc", "conclusion": None}, fresh, "pending"),
    ]
    bad = 0
    for name, run, committed, want in cases:
        got = classify(run, "abc", committed, now)["state"]
        flag = "ok " if got == want else "FAIL"
        if got != want:
            bad += 1
        print(f"  [{flag}] {name}: {got} (want {want})")

    # glob_to_regex / matches_any: the constructs this workflow's paths: list uses.
    globs = ["src/**", "tests/**", "package.json", ".github/workflows/build-console.yml"]
    glob_cases = [
        ("docs-only diff", ["CLAUDE.md", "docs/foo.md"], []),
        ("docs + src file", ["CLAUDE.md", "src/x.ts"], ["src/x.ts"]),
        ("nested src file", ["src/lib/a/b.ts"], ["src/lib/a/b.ts"]),
        ("exact filename match", ["package.json"], ["package.json"]),
        ("unrelated top-level file", ["README.md"], []),
    ]
    for name, files, want_hits in glob_cases:
        got_hits = matches_any(globs, files)
        flag = "ok " if got_hits == want_hits else "FAIL"
        if got_hits != want_hits:
            bad += 1
        print(f"  [{flag}] glob: {name}: {got_hits} (want {want_hits})")

    # resolve_coverage: HEAD has no run — does an ancestor's run cover it?
    coverage_cases = [
        (
            "docs-only diff since a green base -> covered",
            "deadbee", 60, "base01",
            {"databaseId": 111, "conclusion": "success"},
            ["CLAUDE.md", "docs/foo.md"],
            "covered", "success",
        ),
        (
            "docs + src diff since a green base -> unverified",
            "deadbee", 60, "base01",
            {"databaseId": 111, "conclusion": "success"},
            ["CLAUDE.md", "src/x.ts"],
            "unverified", None,
        ),
        (
            "docs-only diff since a FAILED base -> covered, stays red",
            "deadbee", 60, "base01",
            {"databaseId": 222, "conclusion": "failure"},
            ["CLAUDE.md"],
            "covered", "failure",
        ),
        (
            "no base run found within lookback -> unverified",
            "deadbee", 60, None, None, None,
            "unverified", None,
        ),
        (
            "base run itself cancelled -> unverified (proves nothing)",
            "deadbee", 60, "base01",
            {"databaseId": 333, "conclusion": "cancelled"},
            ["CLAUDE.md"],
            "unverified", None,
        ),
    ]
    for name, head_sha, age_min, base_sha, base_run, changed, want_state, want_base_conclusion in coverage_cases:
        got = resolve_coverage(head_sha, age_min, base_sha, base_run, changed, globs)
        ok = got["state"] == want_state and got.get("base_conclusion") == want_base_conclusion
        flag = "ok " if ok else "FAIL"
        if not ok:
            bad += 1
        print(f"  [{flag}] coverage: {name}: {got['state']}/{got.get('base_conclusion')} "
              f"(want {want_state}/{want_base_conclusion})")

    # _is_bad / _is_green must agree that a base-failed 'covered' state is bad,
    # and a base-succeeded one reads exactly like green.
    covered_ok = {"state": "covered", "base_conclusion": "success"}
    covered_bad = {"state": "covered", "base_conclusion": "failure"}
    for name, cur, want_bad, want_green in [
        ("covered/success", covered_ok, False, True),
        ("covered/failure", covered_bad, True, False),
    ]:
        got_bad, got_green = _is_bad(cur), _is_green(cur)
        ok = got_bad == want_bad and got_green == want_green
        flag = "ok " if ok else "FAIL"
        if not ok:
            bad += 1
        print(f"  [{flag}] predicate: {name}: bad={got_bad} green={got_green} "
              f"(want bad={want_bad} green={want_green})")

    print("selftest:", "passed" if not bad else f"{bad} FAILED")
    return 1 if bad else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    now = datetime.now(timezone.utc)
    commits = gh_json(
        ["api", f"repos/{REPO}/commits/{BRANCH}", "--jq", '{sha:.sha,date:.commit.committer.date}']
    )
    head_sha = commits["sha"]
    head_committed = datetime.fromisoformat(commits["date"].replace("Z", "+00:00"))

    runs = gh_json(
        [
            "run", "list", "--repo", REPO, "--workflow", WORKFLOW, "--branch", BRANCH,
            "--limit", "1", "--json", "databaseId,headSha,conclusion,status",
        ]
    )
    newest_run = runs[0] if runs else None
    cur = classify(newest_run, head_sha, head_committed, now)

    # `classify` reports "unverified" for two different shapes: a run that
    # executed and was cancelled (nothing to do about it here), and HEAD
    # having no run of its own at all — the case a paths-filtered workflow
    # produces on every commit outside its `paths:` list. Only the second is
    # worth checking against an ancestor's run; on any lookup failure this
    # falls back to `cur` exactly as `classify` already computed it.
    head_has_no_run = newest_run is None or newest_run.get("headSha") != head_sha
    if cur["state"] == "unverified" and head_has_no_run:
        try:
            paths_globs = load_push_paths()
            base_sha, base_run, changed_files = find_covered_base(head_sha)
            age_min = int((now - head_committed).total_seconds() // 60)
            cur = resolve_coverage(head_sha, age_min, base_sha, base_run, changed_files, paths_globs)
        except Exception:
            pass  # keep the plain 'unverified' cur already computed

    prev = {}
    if STATE_FILE.exists():
        try:
            prev = json.loads(STATE_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            prev = {}  # unreadable state reads as "nothing known", never as green

    bad_now = _is_bad(cur)
    was_bad = bool(prev) and _is_bad(prev)
    # A new sha in the same bad state is a new fact and mails again; the same sha
    # in the same state does not, or a laptop polling every 15 min would send
    # ~96 copies of one failure a day.
    new_condition = bad_now and (not was_bad or prev.get("sha") != cur["sha"])
    recovered = was_bad and _is_green(cur)

    mailed = False
    url = f"https://github.com/{REPO}/actions/runs/{cur['run']}" if cur.get("run") else "(no run)"
    if new_condition:
        # A "covered" bad state points `run` at the ancestor whose failure it
        # inherited; "unverified" from a cancelled run has no failed step to name.
        is_failure_like = cur["state"] == "failure" or (
            cur["state"] == "covered" and cur.get("base_conclusion") not in ("success",)
        )
        where = failing_step(cur["run"]) if is_failure_like and cur.get("run") else "n/a"
        send(
            "job-failed",
            f"build-console {cur['state']} on {cur['sha'][:7]}",
            f"Repository: {REPO}\nBranch: {BRANCH}\nCommit: {cur['sha']}\n"
            f"State: {cur['state']}\nDetail: {cur['detail']}\nFailed step: {where}\nRun: {url}\n\n"
            "What happens next: nothing retries this on its own. A push does not "
            "create a run while Actions is degraded, so re-run it with\n"
            f"  gh workflow run {WORKFLOW} --repo {REPO} --ref {BRANCH}\n",
            args.dry_run,
        )
        mailed = True
    elif recovered:
        send(
            "job-recovered",
            f"build-console green again on {cur['sha'][:7]}",
            f"Repository: {REPO}\nCommit: {cur['sha']}\nRun: {url}\n\n"
            f"Previous state: {prev.get('state')} on {str(prev.get('sha'))[:7]}.\n",
            args.dry_run,
        )
        mailed = True

    if not args.dry_run:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps({**cur, "checked_at": now.isoformat()}, indent=2))
        write_status(cur, mailed)

    print(f"{cur['state']} {cur['sha'][:7]} — {cur['detail']}{' [mailed]' if mailed else ''}")
    return 0


def report_own_failure(exc: BaseException) -> None:
    """An alarm whose own failure is silent is the thing this replaces.

    `gh` reads its token from the login keyring, so an expired login or a locked
    keychain breaks the poll — and the visible result would otherwise be a check
    that has stopped reporting, indistinguishable from a green main. So the
    status file is written first (the menubar reads it), then one mail, deduped
    on the reason so a persistent breakage does not send every 15 minutes.
    """
    reason = f"{type(exc).__name__}: {exc}"[:400]
    try:
        STATUS_DIR.mkdir(parents=True, exist_ok=True)
        (STATUS_DIR / "bg-console-ci.json").write_text(
            json.dumps(
                {
                    "id": "console-ci",
                    "label": "Console CI",
                    "status": "failed",
                    "detail": f"the check itself failed — {reason}",
                    "checked_at": datetime.now(timezone.utc).isoformat(),
                },
                indent=2,
            )
        )
    except OSError:
        pass

    try:
        prev = json.loads(STATE_FILE.read_text()) if STATE_FILE.exists() else {}
    except (json.JSONDecodeError, OSError):
        prev = {}
    if prev.get("self_failure") != reason:
        try:
            send(
                "job-failed",
                "console CI check could not run",
                f"artesca-vss-console/scripts/ci-alert.py failed before it could read the "
                f"workflow state, so the state of main is currently unknown — not green.\n\n"
                f"Reason: {reason}\n\n"
                "What happens next: it retries on the next 15-minute tick. A `gh` auth "
                "failure will not clear on its own — check `gh auth status`.\n",
                dry_run=False,
            )
        except Exception:
            pass  # a mail failure must not mask the original one on stderr
        try:
            STATE_DIR.mkdir(parents=True, exist_ok=True)
            STATE_FILE.write_text(json.dumps({**prev, "self_failure": reason}, indent=2))
        except OSError:
            pass


if __name__ == "__main__":
    try:
        code = main()
    except Exception as e:
        if "--dry-run" in sys.argv or "--selftest" in sys.argv:
            raise
        report_own_failure(e)
        print(f"ci-alert: {type(e).__name__}: {e}", file=sys.stderr)
        code = 1
    sys.exit(code)
