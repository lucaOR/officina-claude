import subprocess
import tempfile
import unittest
from pathlib import Path

import testkit

HERE = Path(__file__).resolve().parent
# Scripts whose argparse requires arguments get just enough to reach the
# no-knowledge-base check; that check, not the arguments, is what is under test.
EXTRA = {
    "check": ["x.txt"],
    "skill_misses": ["--skill", "s", "--rule", "r", "--caught-by", "self"],
}
SCRIPTS = ["build_digest", "validate", "check", "report", "dashboard",
           "adjudicate", "citations", "skill_misses"]


class TestEntrypoints(unittest.TestCase):
    def test_cli_without_kb_exits_zero_with_one_stderr_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = testkit.make_project(Path(tmp))
            for name in SCRIPTS:
                with self.subTest(script=name):
                    proc = subprocess.run(
                        ["python3", str(HERE / f"{name}.py"), "--root", str(root),
                         *EXTRA.get(name, [])],
                        capture_output=True, text=True, cwd=tmp)
                    self.assertEqual(proc.returncode, 0, proc.stderr)
                    self.assertEqual(proc.stdout, "")
                    self.assertEqual(len(proc.stderr.splitlines()), 1, proc.stderr)


if __name__ == "__main__":
    unittest.main()
