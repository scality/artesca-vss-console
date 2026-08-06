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

Mail goes through isv-backend/scripts/notify.py — the fleet's one subject
grammar and X-ISV-Alert routing header, sent on the workspace-mcp OAuth token
rather than anything touching gcloud (a gcloud-dependent alert path goes silent
exactly when the Workspace reauthentication policy is the thing to report).

Three states are worth an email, and the third is the one a "did the run fail"
check misses:

  failure     the run completed red
  unverified  the run was cancelled with nothing executed, or HEAD has no run
              at all. GitHub Actions was in major_outage on 2026-08-06 and
              every push for seven consecutive commits created no run, so a
              check that only looks at the newest run's conclusion reports the
              last green one and says main is fine.
  recovered   the first success after either of those

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
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = "scality/artesca-vss-console"
WORKFLOW = "build-console.yml"
BRANCH = "main"
NOTIFY = Path.home() / "Developer/scality/isv-backend/scripts/notify.py"

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
    ok = cur["state"] in ("green", "pending")
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
    cur = classify(runs[0] if runs else None, head_sha, head_committed, now)

    prev = {}
    if STATE_FILE.exists():
        try:
            prev = json.loads(STATE_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            prev = {}  # unreadable state reads as "nothing known", never as green

    bad_now = cur["state"] in ("failure", "unverified")
    was_bad = prev.get("state") in ("failure", "unverified")
    # A new sha in the same bad state is a new fact and mails again; the same sha
    # in the same state does not, or a laptop polling every 15 min would send
    # ~96 copies of one failure a day.
    new_condition = bad_now and (not was_bad or prev.get("sha") != cur["sha"])
    recovered = was_bad and cur["state"] == "green"

    mailed = False
    url = f"https://github.com/{REPO}/actions/runs/{cur['run']}" if cur.get("run") else "(no run)"
    if new_condition:
        where = failing_step(cur["run"]) if cur["state"] == "failure" and cur.get("run") else "n/a"
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
