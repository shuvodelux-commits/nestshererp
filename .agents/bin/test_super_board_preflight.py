"""Offline Super Board preflight regression against large GitHub evidence.

Copies the real shell script beside a strict stub reader in a disposable
directory. No GitHub, production repo, database, or active board is contacted.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest


SCRIPT = Path(__file__).with_name("super-board-preflight.sh")
READER = """#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys
import time
kind = sys.argv[sys.argv.index("--kind") + 1]
if kind == os.environ.get("PREFLIGHT_STUB_SLEEP_KIND"):
    time.sleep(float(os.environ.get("PREFLIGHT_STUB_SLEEP", "0")))
name = {
    "prs-merged": "merged.json",
    "prs-open": "open.json",
    "issues-closed": "closed.json",
}.get(kind)
if kind == "issue":
    name = "issue-" + sys.argv[sys.argv.index("view") + 1] + ".json"
if not name:
    sys.exit("Unexpected GitHub read: " + repr(sys.argv))
sys.stdout.write((Path(os.environ["PREFLIGHT_FIXTURE_DIR"]) / name).read_text())
"""


class PreflightEvidenceTests(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory(prefix="preflight-fixture-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        shutil.copy2(SCRIPT, self.bin / "super-board-preflight.sh")
        (self.bin / "super-board-github-read.py").write_text(READER)
        self.fixtures = self.root / "fixtures"
        self.fixtures.mkdir()
        self.scratch = self.root / "scratch"
        self.scratch.mkdir()
        self.issue(139)
        self.store("merged", [])
        self.store("open", [])
        self.store("closed", [])

    def store(self, name: str, data: object) -> None:
        (self.fixtures / (name + ".json")).write_text(json.dumps(data))

    def issue(self, number: int, *, name: str = "Fix oversized preflight JSON",
              body: str = "## Acceptance Criteria\n- Process all matching evidence\n") -> None:
        self.store(f"issue-{number}", {"number": number, "title": name, "body": body})

    def execute(self, *extra: str, issues: str = "139",
                envextra: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        env = self.environment(envextra)
        return subprocess.run(
            ["bash", str(self.bin / "super-board-preflight.sh"),
             "--repo", "example/test", "--issues", issues, *extra],
            text=True, capture_output=True, env=env, timeout=30,
        )

    def environment(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        env = os.environ.copy()
        env.update(PREFLIGHT_FIXTURE_DIR=str(self.fixtures), TMPDIR=str(self.scratch))
        if extra:
            env.update(extra)
        return env

    def assert_clean(self) -> None:
        self.assertFalse(list(self.scratch.glob("super-board-preflight.*")))

    def test_empty_data_still_proceeds(self) -> None:
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["139"]["verdict"], "proceed")
        self.assert_clean()

    def test_large_pr_and_issue_payloads_do_not_hit_argument_limit(self) -> None:
        filler = "Long source description, accounting checks and access rules. " * 50
        self.store("merged", [
            {"number": n + 1000, "title": f"Unrelated merged feature {n}",
             "body": filler, "url": f"https://example.test/{n}"}
            for n in range(100)
        ])
        self.store("open", [
            {"number": n + 2000, "title": f"Unrelated open work {n}",
             "body": filler, "headRefName": f"branch-{n}",
             "url": f"https://example.test/{n}", "files": [{"path": f"elsewhere/{n}.ts"}]}
            for n in range(100)
        ])
        self.store("closed", [
            {"number": n + 3000, "title": f"Unrelated closed item {n}",
             "body": filler, "stateReason": "COMPLETED"}
            for n in range(100)
        ])
        for name in ("merged", "open", "closed"):
            self.assertGreater((self.fixtures / f"{name}.json").stat().st_size, 128 * 1024)
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["139"]["verdict"], "proceed")
        self.assert_clean()

    def test_large_target_body_and_multi_issue_batch(self) -> None:
        self.issue(139, body="## Acceptance Criteria\n- Test all paths\n" + ("Large target details\n" * 13000))
        self.issue(140, name="A different change")
        result = self.execute(issues="139,140")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sorted(json.loads(result.stdout)), ["139", "140"])
        self.assert_clean()

    def test_full_merged_history_remains_a_hold(self) -> None:
        self.store("merged", [{"number": 1000, "title": "Unrelated exact name",
                               "body": "Closes #139"}])
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["139"]["tag"], "done")
        self.assert_clean()

    def test_overlapping_open_pr_is_sequenced_not_dropped(self) -> None:
        self.issue(139, body="## Acceptance Criteria\n- Fix .agents/bin/super-board-preflight.sh\n")
        self.store("open", [{"number": 101, "title": "A distinct tool change",
                             "body": "Closes #111", "headRefName": "issue-111",
                             "files": [{"path": ".agents/bin/super-board-preflight.sh"}]}])
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)["139"]
        self.assertEqual(value["verdict"], "sequence")
        self.assertEqual(value["blockedBy"], [111])
        self.assertEqual(value["conflictWith"], [101])
        self.assert_clean()

    def test_missing_acceptance_criteria_still_blocks(self) -> None:
        self.issue(139, body="Fix this without tests")
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["139"]["tag"], "unclear")
        self.assert_clean()

    def test_malformed_json_or_wrong_shape_is_not_proceed(self) -> None:
        for content in ('{"unexpected":"object"}', '[{"valid": true}]\n[{"second":true}]', '[malformed]'):
            with self.subTest(content=content):
                (self.fixtures / "open.json").write_text(content)
                result = self.execute()
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('"verdict": "proceed"', result.stdout)
                self.assert_clean()

    def test_invalid_inflight_is_rejected(self) -> None:
        f = self.root / "inflight.json"
        f.write_text('[]\n[]\n')
        result = self.execute("--inflight", str(f))
        self.assertEqual(result.returncode, 79, result.stderr)
        self.assert_clean()

    def test_signal_cleans_private_temp_files(self) -> None:
        proc = subprocess.Popen(
            ["bash", str(self.bin / "super-board-preflight.sh"),
             "--repo", "example/test", "--issues", "139"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            env=self.environment({"PREFLIGHT_STUB_SLEEP_KIND": "prs-merged",
                                  "PREFLIGHT_STUB_SLEEP": "1.5"}),
        )
        try:
            deadline = time.monotonic() + 4
            while not list(self.scratch.glob("super-board-preflight.*")) and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(list(self.scratch.glob("super-board-preflight.*")))
            proc.terminate()
            proc.communicate(timeout=8)
            self.assertNotEqual(proc.returncode, 0)
            self.assert_clean()
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.communicate()


if __name__ == "__main__":
    unittest.main()
