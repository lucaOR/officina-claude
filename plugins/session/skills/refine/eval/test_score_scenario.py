"""Tests for score_scenario.py. Plain unittest: there is no pytest on this host."""
import atexit
import importlib.util
import json
import subprocess
import sys
import shutil
import tempfile
import unittest
from pathlib import Path

SCORE = Path(__file__).parent / "score_scenario.py"
MAIN = Path(tempfile.mkdtemp(prefix="refine-main-"))   # stands in for the project under test
atexit.register(shutil.rmtree, MAIN, True)
RESULT = {"type": "result", "subtype": "success"}


def asst(*blocks):
    return {"type": "assistant", "message": {"content": list(blocks)}}


def run(records):
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "s.jsonl"
        p.write_text("\n".join(json.dumps(r) for r in records))
        out = subprocess.run([sys.executable, str(SCORE), str(p), "--expect", "baseline", "--project", str(MAIN)],
                             capture_output=True, text=True)
    return out.stdout.splitlines()


class ScoreTest(unittest.TestCase):
    def test_score_flags_spike_call(self):
        lines = run([asst({"type": "tool_use", "name": "Skill", "input": {"skill": "spike"}}), RESULT])
        self.assertTrue(lines[0].startswith("FAIL 1"))

    def test_score_passes_clean_question(self):
        lines = run([asst({"type": "text", "text": "What problem or opportunity prompted this idea?"}), RESULT])
        self.assertEqual([l.split()[0] for l in lines], ["PASS"] * 5)

    def test_score_flags_main_checkout_access_as_contaminated(self):
        reach = {"type": "tool_use", "name": "Bash", "input": {"command": f"cd {MAIN}/.claude && ls skills"}}
        lines = run([asst(reach), RESULT])
        self.assertIn("CONTAMINATED", lines[-1])

    def test_score_clean_run_is_not_contaminated(self):
        own = {"type": "tool_use", "name": "Bash", "input": {"command": "ls ~/.claude/refine /tmp/x/base/.claude"}}
        lines = run([asst(own), RESULT])
        self.assertNotIn("CONTAMINATED", "\n".join(lines))

    def test_contaminated_by_cd_to_home(self):
        home = str(Path.home())
        for cmd in ("cd ~ && ls myproject/.claude", f"cd {home} && grep -rn Purpose myproject/.claude", "cd $HOME; ls",
                    'cd "$HOME" && cat myproject/x', f'cd "{home}" && ls', "pushd ~ && ls myproject", "pushd $HOME"):
            lines = run([asst({"type": "tool_use", "name": "Bash", "input": {"command": cmd}}), RESULT])
            self.assertIn("CONTAMINATED", lines[-1], cmd)

    def test_contaminated_by_search_rooted_at_home(self):
        call = {"type": "tool_use", "name": "Grep", "input": {"pattern": "Purpose", "path": str(Path.home())}}
        self.assertIn("CONTAMINATED", run([asst(call), RESULT])[-1])

    def test_contaminated_by_tool_result_naming_main_checkout(self):
        named = str(MAIN / ".claude" / "intents" / "x.md")
        res = {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t", "content": named}]}}
        self.assertIn("CONTAMINATED", run([asst({"type": "text", "text": "ok"}), res, RESULT])[-1])

    def test_main_checkout_is_derived_not_hard_coded(self):
        spec = importlib.util.spec_from_file_location("score_scenario", SCORE)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        self.assertEqual(mod.main_checkout(MAIN), MAIN.resolve())
        self.assertNotIn("/home/", SCORE.read_text())


if __name__ == "__main__":
    unittest.main()
