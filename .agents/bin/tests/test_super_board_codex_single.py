"""TDD security contract for the single-card native Codex builder (#343 / HisabIQ #655)."""
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

SCRIPT = Path(__file__).resolve().parents[1] / "super-board-codex-single.py"
spec = importlib.util.spec_from_file_location("super_board_codex_single", SCRIPT)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

URL = "https://github.com/shuvodelux-commits/hisabiq_ui/issues/548"
SHA = "a" * 40
REPO = "shuvodelux-commits/hisabiq_ui"


def board(status="Ready", number=548, repo=REPO, url=URL):
    return {"items": [{"status": status, "content": {
        "number": number, "repository": repo, "url": url, "type": "Issue"}}]}


def issue(state="open", labels=()):
    return {"number": 548, "state": state, "html_url": URL,
            "labels": [{"name": name} for name in labels]}


class SingleCodexPolicyTest(unittest.TestCase):
    def test_only_live_ready_exact_issue_is_allowed(self):
        card = guard.select_verified_card(board(), issue())
        self.assertEqual(card["content"]["number"], 548)
        self.assertEqual(card["status"], "Ready")

    def test_blocked_and_forged_ready_are_denied(self):
        for status in ("Blocked", "Backlog", "Building", "QA", "Review", "Done", None):
            with self.subTest(status=status):
                with self.assertRaises(guard.PolicyError):
                    guard.select_verified_card(board(status=status), issue())
        with self.assertRaises(guard.PolicyError):
            guard.select_verified_card(board(status="Blocked"), issue(), claimed={"status": "Ready"})

    def test_wrong_or_missing_issue_repo_or_duplicate_is_denied(self):
        for payload in [board(number=549), board(repo="shuvodelux-commits/nestshererp"),
                        board(url=URL + "/wrong"), {"items": []},
                        {"items": board()["items"] * 2}]:
            with self.subTest(payload=payload):
                with self.assertRaises(guard.PolicyError):
                    guard.select_verified_card(payload, issue())

    def test_closed_or_claimed_issue_denied(self):
        for payload in [issue(state="closed"), issue(labels=("loop:in-progress",)),
                        issue(labels=("loop:halted",))]:
            with self.subTest(payload=payload):
                with self.assertRaises(guard.PolicyError):
                    guard.select_verified_card(board(), payload)

    def test_repo_origin_head_and_cleanliness_are_mandatory(self):
        good = dict(origin="https://github.com/" + REPO + ".git",
                    head=SHA, status="", expected_sha=SHA)
        self.assertIsNone(guard.verify_checkout(**good))
        bad = [dict(status="?? work.txt"), dict(head="b" * 40),
               dict(origin="https://github.com/shuvodelux-commits/nestshererp.git"),
               dict(expected_sha="b" * 40)]
        for changed in bad:
            with self.subTest(changed=changed):
                with self.assertRaises(guard.PolicyError):
                    guard.verify_checkout(**{**good, **changed})

    def test_single_build_command_uses_real_codex_medium_and_no_wave(self):
        command = guard.make_build_command(
            card=guard.select_verified_card(board(), issue()),
            config=Path("/tmp/source-pinned-board-config.json"),
            launcher=Path("/verified/toolkit/super-board-lane.sh"))
        self.assertEqual(command[:2], ["bash", "/verified/toolkit/super-board-lane.sh"])
        self.assertIn("--codex=gpt-6.1-sol", command)
        self.assertIn("--reasoning-effort=medium", command)
        self.assertIn("--lane", command)
        self.assertEqual(command[command.index("--lane") + 1], "build")
        self.assertNotIn("claude", " ".join(command))
        self.assertNotIn("super-board-codex-wave.sh", " ".join(command))

    def test_policy_rejects_before_running_any_worker(self):
        spawn = Mock()
        with self.assertRaises(guard.PolicyError):
            guard.dispatch_checked(
                project=board(status="Blocked"), remote_issue=issue(), origin="https://github.com/" + REPO + ".git",
                head=SHA, status="", expected_sha=SHA, config=Path("/tmp/config.json"),
                launcher=Path("/toolkit/super-board-lane.sh"), execute=spawn)
        spawn.assert_not_called()

    def test_only_one_lock_owner_at_once(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "548.lock"
            with guard.ownership_lock(path):
                with self.assertRaises(guard.PolicyError):
                    with guard.ownership_lock(path):
                        self.fail("second owner must not enter")


if __name__ == "__main__":
    unittest.main()
