"""Behavioral regression for the ChatGPT-assisted Super Build adapter.

Uses only disposable git repositories under TemporaryDirectory; never GitHub,
NestSherERP's worktrees, a running service, or any database.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("super-build-chatgpt.py")


def git(cwd: Path, *args: str) -> str:
    completed = subprocess.run(
        ["git", "-C", str(cwd), *args],
        check=True, capture_output=True, text=True,
    )
    return completed.stdout.strip()


class ChatGPTSuperBuildTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="chatgpt-superbuild-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.seed = self.root / "seed"
        self.seed.mkdir()
        git(self.seed, "init", "-b", "main")
        git(self.seed, "config", "user.email", "test@example.invalid")
        git(self.seed, "config", "user.name", "Disposable Test")
        (self.seed / "README.md").write_text("base\n", encoding="utf-8")
        git(self.seed, "add", "README.md")
        git(self.seed, "commit", "-m", "baseline")
        self.base = git(self.seed, "rev-parse", "HEAD")

        self.remote = self.root / "source.git"
        subprocess.run(
            ["git", "clone", "--bare", str(self.seed), str(self.remote)],
            check=True, capture_output=True, text=True,
        )
        self.checkout = self.root / "checkout"
        subprocess.run(
            ["git", "clone", str(self.remote), str(self.checkout)],
            check=True, capture_output=True, text=True,
        )
        git(self.checkout, "config", "user.email", "test@example.invalid")
        git(self.checkout, "config", "user.name", "Disposable Test")
        git(self.checkout, "checkout", "-b", "feature/test")
        (self.checkout / "approved.txt").write_text("changed\n", encoding="utf-8")
        git(self.checkout, "add", "approved.txt")
        git(self.checkout, "commit", "-m", "approved feature")
        git(self.checkout, "push", "-u", "origin", "feature/test")
        self.head = git(self.checkout, "rev-parse", "HEAD")
        git(self.checkout, "checkout", "main")

        self.dest = self.root / "isolated-worktree"
        self.receipt = self.root / "receipt.json"
        self.issue = "https://github.com/test-owner/test-repo/issues/123"

    def run_cli(self, *args: str, success: bool = True) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            capture_output=True, text=True,
        )
        if success:
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        else:
            self.assertNotEqual(result.returncode, 0, result.stderr + result.stdout)
        return result

    def prepare_args(self) -> list[str]:
        return [
            "prepare", "--repo", str(self.checkout),
            "--remote", str(self.remote),
            "--branch", "feature/test", "--head", self.head,
            "--base", self.base, "--issue", self.issue,
            "--worktree", str(self.dest), "--receipt", str(self.receipt),
            "--allow", "approved.txt",
        ]

    def prepare(self) -> None:
        self.run_cli(*self.prepare_args())

    def test_prepare_verify_finalize_happy_path(self) -> None:
        self.prepare()
        self.assertEqual(git(self.dest, "rev-parse", "HEAD"), self.head)
        self.assertTrue(self.receipt.is_file())

        self.run_cli("verify", "--receipt", str(self.receipt), "--check", "python-version")
        result = self.run_cli("finalize", "--receipt", str(self.receipt))
        payload = json.loads(result.stdout)
        self.assertEqual(payload["state"], "verified")
        self.assertEqual(payload["head"], self.head)
        self.assertEqual(payload["passed_checks"], ["python-version"])
        self.assertFalse(payload["native_launcher_ran"])
        self.assertFalse(payload["merge_authorized"])

    def test_reject_wrong_head(self) -> None:
        args = self.prepare_args()
        args[args.index("--head") + 1] = "f" * 40
        self.run_cli(*args, success=False)
        self.assertFalse(self.dest.exists())

    def test_reject_wrong_origin(self) -> None:
        args = self.prepare_args()
        args[args.index("--remote") + 1] = str(self.root / "different.git")
        self.run_cli(*args, success=False)
        self.assertFalse(self.dest.exists())

    def test_reject_wrong_issue_repository(self) -> None:
        args = self.prepare_args()
        args[args.index("--issue") + 1] = "https://github.com/elsewhere/other/issues/1"
        # A local bare remote cannot prove a github.com issue identity; in the
        # test use --issue only as an opaque trace, not an authorization token.
        self.run_cli(*args, success=True)

    def test_refuse_unapproved_file(self) -> None:
        args = self.prepare_args()
        args[args.index("--allow") + 1] = "not-allowed.txt"
        self.run_cli(*args, success=False)
        self.assertFalse(self.dest.exists())

    def test_reject_existing_destination(self) -> None:
        self.dest.mkdir()
        self.run_cli(*self.prepare_args(), success=False)
        self.assertFalse(self.receipt.exists())

    def test_reject_modified_worktree(self) -> None:
        self.prepare()
        (self.dest / "approved.txt").write_text("local unsafe edit\n", encoding="utf-8")
        self.run_cli("verify", "--receipt", str(self.receipt), "--check", "python-version", success=False)

    def test_finalize_requires_successful_check(self) -> None:
        self.prepare()
        self.run_cli("finalize", "--receipt", str(self.receipt), success=False)

    def test_verifier_never_accepts_arbitrary_command(self) -> None:
        self.prepare()
        self.run_cli("verify", "--receipt", str(self.receipt), "--check", "claude", success=False)
        self.run_cli("verify", "--receipt", str(self.receipt), "--check", "codex", success=False)

    def test_no_reuse_of_receipt(self) -> None:
        self.prepare()
        self.run_cli(*self.prepare_args(), success=False)

    def test_verified_head_must_remain_exact(self) -> None:
        self.prepare()
        self.run_cli("verify", "--receipt", str(self.receipt), "--check", "python-version")
        git(self.dest, "checkout", "--detach", self.base)
        self.run_cli("finalize", "--receipt", str(self.receipt), success=False)


if __name__ == "__main__":
    unittest.main()
