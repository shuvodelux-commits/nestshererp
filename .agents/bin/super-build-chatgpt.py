#!/usr/bin/env python3
"""ChatGPT-operated Super Build workstation adapter.

This is NOT a ChatGPT model runtime or native slash-command host. ChatGPT
authors on GitHub; this script checks out and verifies only the exact approved
GitHub commit, then emits a draft-PR handoff receipt.

Never invokes Claude, Codex, OpenCode, Super Board queues, merges, deploys or
database migrations. Designed for one task per isolated invocation.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit


SHA_RE = re.compile(r"^[0-9a-f]{40}$")
BRANCH_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.\-/]*$")
ISSUE_RE = re.compile(r"^https://github\.com/([^/]+)/([^/]+)/issues/([1-9][0-9]*)$")
VERSION = 1
CHECKS = {
    "python-version": [sys.executable, "--version"],
    "install": ["pnpm", "install", "--frozen-lockfile", "--offline", "--ignore-scripts"],
    "typecheck": ["pnpm", "typecheck"],
    "lint": ["pnpm", "lint"],
    "build": ["pnpm", "build"],
    "boundaries": ["pnpm", "test:boundaries"],
    # HisabIQ React frontend: fixed npm/package-lock commands, never arbitrary scripts.
    "npm-install": ["npm", "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
    "npm-typecheck": ["node_modules/.bin/tsc", "--noEmit"],
    "npm-lint": ["npm", "run", "lint"],
    "npm-ui-contract": ["npm", "run", "check:ui-contract"],
    "npm-unit": ["npm", "test"],
    "npm-build": ["npm", "run", "build"],
}


class Halt(Exception):
    """Deliberate fail-closed preflight halt."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise Halt(message)


def run_git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True, text=True, check=False,
    )
    if check and result.returncode:
        raise Halt("Git verification failed (" + " ".join(args[:3]) + ")")
    return result


def git_output(repo: Path, *args: str) -> str:
    return run_git(repo, *args).stdout.strip()


def ensure_sha(value: str, label: str) -> None:
    require(bool(SHA_RE.fullmatch(value)), label + " must be a full lowercase 40-hex commit SHA")


def ensure_allowed(path: str) -> None:
    p = PurePosixPath(path)
    require(
        bool(path)
        and not p.is_absolute()
        and path not in (".", "..")
        and ".." not in p.parts
        and ".git" not in p.parts
        and "\\" not in path
        and "*" not in path
        and "?" not in path,
        "Unsafe or ambiguous allowed path: " + path,
    )
    require(str(p) == path, "Allowed path must be canonical: " + path)


def norm_remote(remote: str) -> str:
    # Only a local fixture path or the exact expected GitHub repository is
    # supported. This check protects users from verifying a lookalike repo.
    if remote.startswith("https://github.com/"):
        url = urlsplit(remote)
        require(url.username is None and url.password is None, "Remote URL must not contain credentials")
        require(not url.query and not url.fragment and url.port is None, "Remote URL has unexpected qualifiers")
        return "https://github.com/" + url.path.strip("/").removesuffix(".git")
    if remote.startswith("git@github.com:"):
        return "https://github.com/" + remote.split(":", 1)[1].strip("/").removesuffix(".git")
    p = Path(remote)
    require(p.is_absolute(), "Remote must be GitHub HTTPS/SSH or an absolute local test path")
    return str(p.resolve())


def repo_from_remote(remote: str) -> str | None:
    parsed = norm_remote(remote)
    if not parsed.startswith("https://github.com/"):
        return None
    path = parsed.removeprefix("https://github.com/")
    parts = path.split("/")
    require(len(parts) == 2 and all(parts), "Expected GitHub owner/repository remote")
    return "/".join(parts).lower()


def ensure_repo(repo: Path, expected_remote: str) -> None:
    require(repo.is_dir(), "Repository checkout does not exist")
    root = Path(git_output(repo, "rev-parse", "--show-toplevel")).resolve()
    require(root == repo.resolve(), "Repository argument must be the checkout root")
    actual = git_output(repo, "remote", "get-url", "origin")
    require(norm_remote(actual) == norm_remote(expected_remote), "Wrong GitHub origin / remote")
    require(not git_output(repo, "status", "--porcelain"), "Repository checkout contains local edits")


def ensure_branch(branch: str) -> None:
    require(
        bool(BRANCH_RE.fullmatch(branch))
        and ".." not in branch
        and "//" not in branch
        and not branch.endswith(("/", ".", ".lock")),
        "Invalid branch name",
    )


def changed_paths(repo: Path, base: str, head: str, allowed: list[str]) -> list[str]:
    paths = [p for p in git_output(repo, "diff", "--name-only", base + ".." + head).splitlines() if p]
    unexpected = sorted(set(paths) - set(allowed))
    require(not unexpected, "Changed files exceed allowlist: " + ", ".join(unexpected))
    return paths


def atomic_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", dir=path.parent, prefix=".chatgpt-superbuild-", delete=False, encoding="utf-8") as tmp:
        json.dump(data, tmp, indent=2, sort_keys=True)
        tmp.write("\n")
        temp_path = Path(tmp.name)
    try:
        os.chmod(temp_path, 0o600)
        os.replace(temp_path, path)
    finally:
        temp_path.unlink(missing_ok=True)


def read_receipt(file: str) -> tuple[Path, dict]:
    path = Path(file).expanduser().resolve()
    require(path.is_file(), "Receipt file is missing")
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    require(data.get("version") == VERSION and data.get("mode") == "chatgpt-assisted", "Wrong receipt version/mode")
    return path, data


def ensure_checked_out(data: dict) -> Path:
    worktree = Path(data["worktree"]).resolve()
    require(worktree.is_dir(), "Prepared worktree does not exist")
    require(git_output(worktree, "rev-parse", "HEAD") == data["head"], "Worktree HEAD changed from approved SHA")
    ensure_repo(worktree, data["remote"])
    changed_paths(worktree, data["base"], data["head"], data["allow"])
    return worktree


def prepare(args: argparse.Namespace) -> None:
    ensure_sha(args.head, "Head")
    ensure_sha(args.base, "Base")
    ensure_branch(args.branch)
    match = ISSUE_RE.fullmatch(args.issue)
    require(match is not None, "Issue must be a canonical GitHub issue URL")
    remote_repo = repo_from_remote(args.remote)
    if remote_repo is not None:
        issue_repo = (match.group(1) + "/" + match.group(2)).lower()
        require(issue_repo == remote_repo, "Issue belongs to a different GitHub repository")
    require(bool(args.allow), "At least one changed path must be explicitly allowed")
    for path in args.allow:
        ensure_allowed(path)
    require(len(set(args.allow)) == len(args.allow), "Duplicate path in allowlist")

    repo = Path(args.repo).expanduser().resolve()
    worktree = Path(args.worktree).expanduser().resolve()
    receipt = Path(args.receipt).expanduser().resolve()
    require(Path(args.repo).is_absolute() and Path(args.worktree).is_absolute() and Path(args.receipt).is_absolute(),
            "Repository, worktree and receipt must use absolute paths")
    require(not worktree.exists() and not worktree.is_symlink(), "Refusing to reuse an existing worktree")
    require(not receipt.exists(), "Refusing to reuse an existing receipt")
    require(not worktree.is_relative_to(repo), "Isolated worktree cannot live inside checkout")
    require(not receipt.is_relative_to(repo) and not receipt.is_relative_to(worktree),
            "Receipt must stay outside source checkouts")
    ensure_repo(repo, args.remote)

    # Network fetch into the existing checkout; never edit its working files.
    run_git(repo, "fetch", "--no-tags", "origin", "refs/heads/" + args.branch)
    fetched = git_output(repo, "rev-parse", "FETCH_HEAD")
    require(fetched == args.head, "GitHub branch moved: HEAD does not equal approved SHA")
    require(run_git(repo, "merge-base", "--is-ancestor", args.base, args.head, check=False).returncode == 0,
            "Approved base is not an ancestor of branch")
    paths = changed_paths(repo, args.base, args.head, args.allow)

    worktree.parent.mkdir(parents=True, exist_ok=True)
    run_git(repo, "worktree", "add", "--detach", str(worktree), args.head)
    require(git_output(worktree, "rev-parse", "HEAD") == args.head, "Checkout SHA mismatch")
    ensure_repo(worktree, args.remote)

    record = {
        "version": VERSION,
        "mode": "chatgpt-assisted",
        "issue": args.issue,
        "repo": str(repo),
        "remote": args.remote,
        "branch": args.branch,
        "worktree": str(worktree),
        "base": args.base,
        "head": args.head,
        "allow": sorted(args.allow),
        "changed_files": paths,
        "checks": [],
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "native_launcher_ran": False,
        "merge_authorized": False,
    }
    atomic_json(receipt, record)
    print(json.dumps({"state": "prepared", "head": args.head, "worktree": str(worktree),
                      "changed_files": paths, "receipt": str(receipt), "native_launcher_ran": False}))


def command_for(worktree: Path, check: str) -> list[str]:
    """Choose only a pinned command under exactly one root lockfile contract."""
    require(check in CHECKS, "Check not supported; no arbitrary commands or model dispatch")
    if check == "python-version":
        return CHECKS[check]

    pnpm_lock = (worktree / "pnpm-lock.yaml").is_file()
    npm_lock = (worktree / "package-lock.json").is_file()
    require(pnpm_lock != npm_lock, "Expected exactly one root package manager lockfile")
    require(
        npm_lock if check.startswith("npm-") else pnpm_lock,
        "Verification check does not match the repository package manager",
    )
    return CHECKS[check]


def verify(args: argparse.Namespace) -> None:
    file, data = read_receipt(args.receipt)
    worktree = ensure_checked_out(data)
    command = command_for(worktree, args.check)
    started = time.monotonic()
    result = subprocess.run(command, cwd=worktree, capture_output=True, text=True, check=False)
    duration = round(time.monotonic() - started, 3)
    # A local tool may write generated files. Never accept a changed source.
    clean = git_output(worktree, "status", "--porcelain") == ""
    check = {
        "name": args.check, "exit_code": result.returncode,
        "duration_seconds": duration,
        "clean_after": clean,
        "utc": datetime.now(timezone.utc).isoformat(),
    }
    data["checks"].append(check)
    atomic_json(file, data)
    print(json.dumps(check))
    require(result.returncode == 0, "Verification failed (nonzero exit); check details in the selected command's normal output")
    require(clean, "Verification dirtied the source checkout; no success claim")


def finalize(args: argparse.Namespace) -> None:
    _, data = read_receipt(args.receipt)
    ensure_checked_out(data)
    checks = data.get("checks", [])
    require(bool(checks), "No verification command has been executed")
    # Keep the entire failed history, but permit a successful retry for the
    # same named verification check. A passing different check never hides an
    # unresolved failure, and every attempt remains in the receipt.
    latest = {check["name"]: check for check in checks}
    require(all(check["exit_code"] == 0 and check["clean_after"] for check in latest.values()),
            "One or more verification checks still fail; cannot finalize")
    failed_attempts = sum(
        1 for check in checks if check["exit_code"] != 0 or not check["clean_after"]
    )
    result = {
        "state": "verified",
        "issue": data["issue"],
        "branch": data["branch"],
        "base": data["base"],
        "head": data["head"],
        "changed_files": data["changed_files"],
        "passed_checks": list(latest),
        "verification_attempts": len(checks),
        "failed_attempts": failed_attempts,
        "native_launcher_ran": False,
        "merge_authorized": False,
        "draft_pr_required": True,
        "independent_qa_required": True,
    }
    print(json.dumps(result, indent=2, sort_keys=True))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    prepare_cmd = sub.add_parser("prepare", help="Fetch an exact GitHub branch into a new isolated read/test worktree")
    for flag in ("repo", "remote", "branch", "head", "base", "issue", "worktree", "receipt"):
        prepare_cmd.add_argument("--" + flag, required=True)
    prepare_cmd.add_argument("--allow", action="append", required=True, help="One exact allowed changed path; repeat as needed")
    check_cmd = sub.add_parser("verify", help="Run one explicitly selected static check (never a coding model)")
    check_cmd.add_argument("--receipt", required=True)
    check_cmd.add_argument("--check", required=True, choices=sorted(CHECKS))
    finalize_cmd = sub.add_parser("finalize", help="Revalidate source and print verified draft-PR handoff")
    finalize_cmd.add_argument("--receipt", required=True)

    args = parser.parse_args()
    try:
        if args.action == "prepare":
            prepare(args)
        elif args.action == "verify":
            verify(args)
        elif args.action == "finalize":
            finalize(args)
        else:
            raise Halt("Unknown action")
    except (Halt, FileNotFoundError, OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
        print("BLOCKED: " + str(exc), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
