import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import postcommit

HOOK = Path(__file__).resolve().parent.parent / "hooks" / "check-on-edit.py"


class TestCheckable(unittest.TestCase):
    def test_keeps_only_the_suffixes_the_edit_hook_runs_on(self):
        # check-on-edit.py:13 CHECKABLE. A marker for a suffix the edit hook never sees
        # can never pair with an edit-phase row, so recording it is pure volume.
        files = ["app/A.php", "config/x.yaml", "b.yml", "s.sh", "t.py",
                 "src/app.ts", "README.md", "logo.svg"]
        self.assertEqual(postcommit.checkable(files),
                         ["app/A.php", "config/x.yaml", "b.yml", "s.sh", "t.py"])

    @unittest.skipUnless(HOOK.is_file(), "hooks/check-on-edit.py arrives with the hooks")
    def test_matches_the_edit_hook_set_exactly(self):
        # Guard against the two drifting apart: if someone widens one, this fails.
        import check_on_edit_shim as edit
        self.assertEqual(postcommit.CHECKABLE, edit.CHECKABLE)

    def test_empty_in_empty_out(self):
        self.assertEqual(postcommit.checkable([]), [])


if __name__ == "__main__":
    unittest.main()
