"""Behavioral regression for the ChatGPT-assisted Super Build adapter.

Uses only disposable git repositories under TemporaryDirectory; never GitHub,
NestSherERP's worktrees, a running service, or any database.
"""
from __future__ import annotations

import json
import runpy
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
        (self.seed / ".gitignore").write_text("node_modules/\n", encoding="utf-8")
        (self.seed / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n", encoding="utf-8")
        (self.seed / "package.json").write_text(json.dumps({
            "name": "fixture", "version": "1.0.0",
            "scripts": {"build": "true", "lint": "true", "typecheck": "true",
                        "test:boundaries": "true", "check:ui-contract": "true"},
        }), encoding="utf-8")
        git(self.seed, "add", "README.md", ".gitignore", "pnpm-lock.yaml", "package.json")
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
        self.branch = "feature/test"
        git(self.checkout, "checkout", "main")

        self.dest = self.root / "isolated-worktree"
        self.receipt = self.root / "receipt.json"
        self.issue = "https://github.com/test-owner/test-repo/issues/123"

    def run_cli(self, *args: str, success: bool = True,
                environment: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        env = {**os.environ, **(environment or {})}
        result = subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            capture_output=True, text=True, env=env,
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
            "--branch", self.branch, "--head", self.head,
            "--base", self.base, "--issue", self.issue,
            "--worktree", str(self.dest), "--receipt", str(self.receipt),
            "--allow", "approved.txt",
        ]

    def prepare(self) -> None:
        self.run_cli(*self.prepare_args())


    def select_lockfiles(
        self, *, pnpm: bool = False, npm: bool = False,
        scripts: dict[str, str] | None = None,
        stale_lock: bool = False,
    ) -> None:
        """Commit fixture lockfiles on main, then a fresh feature branch."""
        git(self.checkout, "checkout", "main")
        for name in ("pnpm-lock.yaml", "package-lock.json"):
            (self.checkout / name).unlink(missing_ok=True)
        package = {
            "name": "fixture", "version": "1.0.0",
            "scripts": scripts if scripts is not None else {
                "build": "true", "lint": "true", "check:ui-contract": "true",
            },
        }
        (self.checkout / "package.json").write_text(json.dumps(package), encoding="utf-8")
        if pnpm:
            (self.checkout / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\\n", encoding="utf-8")
        if npm:
            lock_name = "incorrect" if stale_lock else "fixture"
            (self.checkout / "package-lock.json").write_text(json.dumps({
                "name": lock_name, "version": "1.0.0", "lockfileVersion": 3,
                "packages": {"": {"name": lock_name, "version": "1.0.0"}},
            }), encoding="utf-8")
        git(self.checkout, "add", "-A")
        git(self.checkout, "commit", "-m", "package manager baseline")
        self.base = git(self.checkout, "rev-parse", "HEAD")
        self.branch = "feature/package"
        git(self.checkout, "checkout", "-b", self.branch)
        (self.checkout / "approved.txt").write_text("changed\\n", encoding="utf-8")
        git(self.checkout, "add", "approved.txt")
        git(self.checkout, "commit", "-m", "feature after package manager baseline")
        git(self.checkout, "push", "-u", "origin", self.branch)
        self.head = git(self.checkout, "rev-parse", "HEAD")
        git(self.checkout, "checkout", "main")

    def fake_package_binary(self, name: str = "npm") -> dict[str, str]:
        """Fake executables only in disposable fixture PATH; never real installs."""
        bindir = self.root / "bin"
        bindir.mkdir(exist_ok=True)
        path = bindir / name
        path.write_text(
            "#!/bin/sh\\n"
            "printf '%s\\n' \\"$*\\" >> \\"$SUPERBUILD_TEST_COMMAND_LOG\\"\\n"
            "if [ \\"$SUPERBUILD_TEST_FAIL_INSTALL\\" = 1 ] && "
            "[ \\"$1\\" = ci ]; then exit 42; fi\\n"
            "exit 0\\n", encoding="utf-8",
        )
        path.chmod(0o755)
        return {
            "PATH": str(bindir) + os.pathsep + os.environ["PATH"],
            "SUPERBUILD_TEST_COMMAND_LOG": str(self.root / "commands.log"),
        }

    def verify_check(self, name: str, *, success: bool = True,
                     environment: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        return self.run_cli("verify", "--receipt", str(self.receipt),
                            "--check", name, success=success, environment=environment)

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

    def test_finalize_preserves_but_allows_recovered_failure(self) -> None:
        self.prepare()
        self.run_cli("verify", "--receipt", str(self.receipt), "--check", "python-version")
        data = json.loads(self.receipt.read_text(encoding="utf-8"))
        old_failed = dict(data["checks"][0])
        old_failed["exit_code"] = 2
        data["checks"].insert(0, old_failed)
        self.receipt.write_text(json.dumps(data), encoding="utf-8")
        result = self.run_cli("finalize", "--receipt", str(self.receipt))
        payload = json.loads(result.stdout)
        self.assertEqual(payload["failed_attempts"], 1)
        self.assertEqual(payload["passed_checks"], ["python-version"])

    def test_finalize_blocks_unresolved_failed_check(self) -> None:
        self.prepare()
        self.run_cli("verify", "--receipt", str(self.receipt), "--check", "python-version")
        data = json.loads(self.receipt.read_text(encoding="utf-8"))
        data["checks"].append({"name": "typecheck", "exit_code": 2, "clean_after": True})
        self.receipt.write_text(json.dumps(data), encoding="utf-8")
        self.run_cli("finalize", "--receipt", str(self.receipt), success=False)

    def test_verified_head_must_remain_exact(self) -> None:
        self.prepare()
        self.run_cli("verify", "--receipt", str(self.receipt), "--check", "python-version")
        git(self.dest, "checkout", "--detach", self.base)
        self.run_cli("finalize", "--receipt", str(self.receipt), success=False)


    def test_npm_frontend_presets_are_immutable_and_work_only_with_npm_lock(self) -> None:
        """No arbitrary command supplied by client may reach subprocess.run."""
        command_for = runpy.run_path(str(SCRIPT))["command_for"]
        npm = self.root / "npm-fixture"
        npm.mkdir()
        (npm / "package-lock.json").write_text("{}", encoding="utf-8")
        expected = {
            "npm-install": ["npm", "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
            "npm-typecheck": ["node_modules/.bin/tsc", "--noEmit"],
            "npm-lint": ["npm", "run", "lint"],
            "npm-ui-contract": ["npm", "run", "check:ui-contract"],
            "npm-unit": ["npm", "test"],
            "npm-build": ["npm", "run", "build"],
        }
        for name, command in expected.items():
            with self.subTest(name=name):
                self.assertEqual(command_for(npm, name), command)

    def test_npm_presets_refuse_missing_wrong_and_dual_lockfile_state(self) -> None:
        command_for = runpy.run_path(str(SCRIPT))["command_for"]
        missing = self.root / "no-lock"
        missing.mkdir()
        pnpm = self.root / "pnpm-fixture"
        pnpm.mkdir()
        (pnpm / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n", encoding="utf-8")
        ambiguous = self.root / "both-locks"
        ambiguous.mkdir()
        (ambiguous / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n", encoding="utf-8")
        (ambiguous / "package-lock.json").write_text("{}", encoding="utf-8")
        for root in (missing, pnpm, ambiguous):
            for preset in ("npm-install", "npm-typecheck", "npm-lint", "npm-unit"):
                with self.subTest(root=root.name, preset=preset):
                    with self.assertRaises(Exception):
                        command_for(root, preset)

    def test_existing_pnpm_checks_remain_supported_and_require_pnpm_lock(self) -> None:
        command_for = runpy.run_path(str(SCRIPT))["command_for"]
        pnpm = self.root / "pnpm-valid"
        pnpm.mkdir()
        (pnpm / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n", encoding="utf-8")
        for check, command in {
            "install": ["pnpm", "install", "--frozen-lockfile", "--offline", "--ignore-scripts"],
            "typecheck": ["pnpm", "typecheck"],
            "lint": ["pnpm", "lint"],
            "build": ["pnpm", "build"],
            "boundaries": ["pnpm", "test:boundaries"],
        }.items():
            with self.subTest(check=check):
                self.assertEqual(command_for(pnpm, check), command)
        npm = self.root / "npm-only"
        npm.mkdir()
        (npm / "package-lock.json").write_text("{}", encoding="utf-8")
        for root in (npm, self.root):
            with self.assertRaises(Exception):
                command_for(root, "install")

    def test_unknown_verification_commands_never_obtain_command_execution(self) -> None:
        command_for = runpy.run_path(str(SCRIPT))["command_for"]
        npm = self.root / "npm-verified"
        npm.mkdir()
        (npm / "package-lock.json").write_text("{}", encoding="utf-8")
        for value in ("bash", "claude", "codex", "npm-run:postinstall",
                      "npm-build;rm -rf /tmp/safe", "../../../etc/passwd"):
            with self.subTest(value=value):
                with self.assertRaises(Exception):
                    command_for(npm, value)


    def test_npm_lockfile_routes_to_offline_ci_and_fixed_checks(self) -> None:
        self.select_lockfiles(npm=True)
        env = self.fake_package_binary("npm")
        self.prepare()
        receipt = json.loads(self.receipt.read_text(encoding="utf-8"))
        self.assertEqual(receipt["package_manager"], "npm")
        for check in ("install", "build", "lint", "boundaries"):
            self.verify_check(check, environment=env)
        tsc = self.dest / "node_modules" / ".bin" / "tsc"
        tsc.parent.mkdir(parents=True)
        tsc.write_text("#!/bin/sh\\necho tsc-ok >> \\"$SUPERBUILD_TEST_COMMAND_LOG\\"\\n", encoding="utf-8")
        tsc.chmod(0o755)
        self.verify_check("typecheck", environment=env)
        lines = (self.root / "commands.log").read_text(encoding="utf-8").splitlines()
        self.assertEqual(lines[:4], [
            "ci --offline --ignore-scripts --no-audit --no-fund",
            "run build", "run lint", "run check:ui-contract",
        ])
        self.assertEqual(lines[4], "tsc-ok")
        final = json.loads(self.run_cli("finalize", "--receipt", str(self.receipt)).stdout)
        self.assertEqual(final["state"], "verified")
        self.assertEqual(final["passed_checks"], ["install", "build", "lint", "boundaries", "typecheck"])

    def test_existing_pnpm_presets_remain_exactly_unchanged(self) -> None:
        self.select_lockfiles(pnpm=True)
        env = self.fake_package_binary("pnpm")
        self.prepare()
        self.assertEqual(json.loads(self.receipt.read_text())["package_manager"], "pnpm")
        for check in ("install", "build", "typecheck", "lint", "boundaries"):
            self.verify_check(check, environment=env)
        lines = (self.root / "commands.log").read_text().splitlines()
        self.assertEqual(lines, [
            "install --frozen-lockfile --offline --ignore-scripts",
            "build", "typecheck", "lint", "test:boundaries",
        ])
        self.run_cli("finalize", "--receipt", str(self.receipt))

    def test_no_lockfile_fails_before_worktree_or_receipt(self) -> None:
        self.select_lockfiles()
        result = self.run_cli(*self.prepare_args(), success=False)
        self.assertIn("lockfile", result.stderr.lower())
        self.assertFalse(self.dest.exists())
        self.assertFalse(self.receipt.exists())

    def test_both_lockfiles_fail_closed_before_worktree(self) -> None:
        self.select_lockfiles(npm=True, pnpm=True)
        result = self.run_cli(*self.prepare_args(), success=False)
        self.assertIn("lockfile", result.stderr.lower())
        self.assertFalse(self.dest.exists())
        self.assertFalse(self.receipt.exists())

    def test_uncommitted_lockfile_is_rejected_as_dirty_checkout(self) -> None:
        self.select_lockfiles()
        (self.checkout / "package-lock.json").write_text("{}", encoding="utf-8")
        result = self.run_cli(*self.prepare_args(), success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.dest.exists())

    def test_stale_npm_lock_identity_is_rejected_without_install(self) -> None:
        self.select_lockfiles(npm=True, stale_lock=True)
        result = self.run_cli(*self.prepare_args(), success=False)
        self.assertIn("lock", result.stderr.lower())
        self.assertFalse(self.dest.exists())

    def test_missing_npm_script_refuses_check_and_preserves_failure(self) -> None:
        self.select_lockfiles(npm=True, scripts={"build": "true"})
        self.prepare()
        result = self.verify_check("lint", success=False)
        self.assertIn("script", result.stderr.lower())
        checks = json.loads(self.receipt.read_text())["checks"]
        self.assertEqual(checks[-1]["name"], "lint")
        self.assertNotEqual(checks[-1]["exit_code"], 0)
        self.run_cli("finalize", "--receipt", str(self.receipt), success=False)

    def test_npm_typecheck_fails_without_local_tsc_or_script(self) -> None:
        self.select_lockfiles(npm=True)
        self.prepare()
        result = self.verify_check("typecheck", success=False)
        self.assertIn("typescript", result.stderr.lower())
        self.assertFalse(self.dest.joinpath("node_modules").exists())
        self.run_cli("finalize", "--receipt", str(self.receipt), success=False)

    def test_npm_typecheck_script_is_preferred_when_present(self) -> None:
        self.select_lockfiles(npm=True, scripts={
            "typecheck": "tsc --noEmit", "build": "true",
            "lint": "true", "check:ui-contract": "true",
        })
        env = self.fake_package_binary("npm")
        self.prepare()
        self.verify_check("typecheck", environment=env)
        self.assertEqual((self.root / "commands.log").read_text().strip(), "run typecheck")

    def test_offline_npm_failure_then_success_retains_failed_history(self) -> None:
        self.select_lockfiles(npm=True)
        env = self.fake_package_binary("npm")
        self.prepare()
        result = self.verify_check("install", environment={
            **env, "SUPERBUILD_TEST_FAIL_INSTALL": "1",
        }, success=False)
        self.assertIn("Verification failed", result.stderr)
        self.verify_check("install", environment=env)
        final = json.loads(self.run_cli("finalize", "--receipt", str(self.receipt)).stdout)
        self.assertEqual(final["failed_attempts"], 1)
        self.assertEqual(final["verification_attempts"], 2)


if __name__ == "__main__":
    unittest.main()
