import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import filelock


class TestFilelock(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "sub" / "x.lock"

    def tearDown(self):
        self.tmp.cleanup()

    def test_second_nonblocking_raises_busy(self):
        with filelock.exclusive(self.path):
            with self.assertRaises(filelock.Busy):
                with filelock.exclusive(self.path, blocking=False):
                    pass
        with filelock.exclusive(self.path, blocking=False):
            pass

    def test_windows_branch_uses_msvcrt(self):
        calls = []
        fake = types.SimpleNamespace(LK_LOCK=1, LK_NBLCK=2, LK_UNLCK=0,
                                     locking=lambda fd, mode, n: calls.append((mode, n)))
        with mock.patch.object(sys, "platform", "win32"), \
                mock.patch.dict(sys.modules, {"msvcrt": fake}):
            with filelock.exclusive(self.path):
                pass
            with filelock.exclusive(self.path, blocking=False):
                pass
        self.assertEqual(calls, [(1, 1), (0, 1), (2, 1), (0, 1)])


if __name__ == "__main__":
    unittest.main()
