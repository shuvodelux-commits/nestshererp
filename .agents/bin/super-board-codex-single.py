#!/usr/bin/env python3
"""Fail-closed, single-card Codex Super Build guard for HisabIQ #548.

Tooling-only. Never creates a worktree, changes a Project card or auto-merges.
Uses the existing super-board-lane.sh native Codex backend, never Claude.
"""
import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys

TARGET_REPO = "shuvodelux-commits/hisabiq_ui"
TARGET_URL = f"https://github.com/{TARGET_REPO}/issues/548"
BACKEND_PIN = "57585270eda42f89748bbd01b134a5e1ed805f6b"
ISSUE = 548


class PolicyError(RuntimeError):
    pass


def select_verified_card(project, remote_issue, claimed=None):
    """Use a live, provider-owned card and issue, never a claimed Ready status."""
    if not isinstance(project, dict) or not isinstance(project.get("items"), list):
        raise PolicyError("Project #2 status unavailable")
    matches = [card for card in project["items"] if isinstance(card, dict)
               and isinstance(card.get("content"), dict)
               and (card["content"].get("number") == ISSUE
                    or card["content"].get("url") == TARGET_URL)]
    if len(matches) != 1:
        raise PolicyError("Expected precisely one live #548 Project card")
    card = matches[0]
    content = card["content"]
    if (card.get("status") != "Ready" or content.get("type") != "Issue"
            or content.get("number") != ISSUE or content.get("repository") != TARGET_REPO
            or content.get("url") != TARGET_URL):
        raise PolicyError("#548 is not an authorized Ready card for HisabIQ")
    if not isinstance(remote_issue, dict) or remote_issue.get("number") != ISSUE or (
        remote_issue.get("html_url") != TARGET_URL or remote_issue.get("state") != "open"
    ):
        raise PolicyError("Live GitHub issue #548 is not open or does not match")
    labels = remote_issue.get("labels", [])
    if not isinstance(labels, list):
        raise PolicyError("Cannot verify issue ownership labels")
    names = {label.get("name") for label in labels if isinstance(label, dict)}
    if names & {"loop:in-progress", "loop:halted", "human-gated"}:
        raise PolicyError("Issue already claimed, halted or human-gated")
    # 'claimed' is never an authority source, even if it says Ready.
    return card


def verify_checkout(*, origin, head, status, expected_sha):
    if not isinstance(expected_sha, str) or not re.fullmatch(r"[0-9a-f]{40}", expected_sha):
        raise PolicyError("Approved frontend pin must be an exact commit SHA")
    if origin.strip() != f"https://github.com/{TARGET_REPO}.git":
        raise PolicyError("Refusing to run in another or ambiguous repository")
    if head.strip() != expected_sha:
        raise PolicyError("Frontend HEAD differs from the approved exact source SHA")
    if status.strip():
        raise PolicyError("Selected frontend worktree is dirty")
    return None


def make_build_command(*, card, config, launcher):
    if card.get("status") != "Ready" or card.get("content", {}).get("url") != TARGET_URL:
        raise PolicyError("Unverified card cannot form a builder command")
    return ["bash", str(launcher), "--backend", "codex",
            "--config", str(config), "--card", json.dumps(card, sort_keys=True),
            "--lane", "build", "--codex=gpt-6.1-sol", "--reasoning-effort=medium"]


def dispatch_checked(*, project, remote_issue, origin, head, status, expected_sha,
                     config, launcher, execute):
    card = select_verified_card(project, remote_issue)
    verify_checkout(origin=origin, head=head, status=status, expected_sha=expected_sha)
    return execute(make_build_command(card=card, config=config, launcher=launcher), check=True)


@contextmanager
def ownership_lock(path):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise PolicyError("Another #548 builder owns the local lock") from exc
        yield
    finally:
        os.close(fd)


def command_output(argv, *, cwd=None):
    try:
        completed = subprocess.run(argv, cwd=cwd, text=True, capture_output=True,
                                   check=True, timeout=30)
    except (OSError, subprocess.SubprocessError) as exc:
        raise PolicyError(f"Required read failed: {argv[0]} {argv[1]}") from exc
    return completed.stdout.strip()


def live_github():
    try:
        project = json.loads(command_output(["gh", "project", "item-list", "2",
            "--owner", "shuvodelux-commits", "--limit", "500", "--format", "json"]))
        issue = json.loads(command_output(["gh", "api",
            f"repos/{TARGET_REPO}/issues/{ISSUE}"]))
    except (ValueError, TypeError) as exc:
        raise PolicyError("Live GitHub response was malformed") from exc
    return project, issue


def git_value(root, *args):
    return command_output(["git", *args], cwd=root)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Single native Codex Medium build for approved Ready #548")
    parser.add_argument("--only", type=int, required=True)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--frontend-sha", required=True)
    parser.add_argument("--backend-sha", required=True)
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args(argv)

    try:
        if args.only != ISSUE:
            raise PolicyError("This guard is scoped exclusively to #548")
        if args.backend_sha != BACKEND_PIN:
            raise PolicyError("Backend SHA needs separate source-pair review and approval")
        root = args.repo_root.resolve(strict=True)
        config = args.config.resolve(strict=True)
        launcher = Path(__file__).resolve().with_name("super-board-lane.sh")
        if not launcher.is_file():
            raise PolicyError("Verified native Codex lane is missing")
        if not (root / ".claude/skills/super-build/SKILL.md").is_file():
            raise PolicyError("Frontend lacks required project-local Super Build skill")
        if not (root / ".claude/bin/super-board-github-read.py").is_file():
            raise PolicyError("Frontend lacks required verified GitHub-read helper")
        with ownership_lock(Path.home() / ".cache/hisabiq-superbuild/codex-single-548.lock"):
            project, issue = live_github()
            dispatch_checked(
                project=project, remote_issue=issue,
                origin=git_value(root, "remote", "get-url", "origin"),
                head=git_value(root, "rev-parse", "HEAD"),
                status=git_value(root, "status", "--porcelain"),
                expected_sha=args.frontend_sha,
                config=config, launcher=launcher,
                execute=lambda command, check: subprocess.run(command, cwd=root, check=check))
    except (OSError, subprocess.SubprocessError, PolicyError) as exc:
        print(f"BLOCKED: {exc}", file=sys.stderr)
        return 10
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
