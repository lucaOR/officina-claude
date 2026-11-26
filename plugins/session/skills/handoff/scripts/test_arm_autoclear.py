#!/usr/bin/env python3
"""Tests for the auto-clear flag writer. Plain stdlib unittest:
    python3 plugins/session/skills/handoff/scripts/test_arm_autoclear.py
"""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "arm_autoclear", Path(__file__).with_name("arm_autoclear.py"))
arm_autoclear = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(arm_autoclear)

SID = "c65279cd-3a7c-40a7-85a3-ab24061676fc"
PTR = f"read /n.md — HANDOFF v1 mode=mid parent={SID}"


class ArmTest(unittest.TestCase):
    def test_writes_flag_json(self):
        with tempfile.TemporaryDirectory() as home:
            p = arm_autoclear.arm(SID, PTR, home=Path(home), now=1000)
            self.assertEqual(p, Path(home) / ".claude" / "handoff" / f"{SID}.autoclear")
            self.assertEqual(json.loads(p.read_text()),
                             {"session_id": SID, "pointer": PTR, "created_at": 1000})

    def test_rejects_bad_session_id(self):
        with self.assertRaises(ValueError):
            arm_autoclear.arm("../x", PTR, home=Path("/tmp"), now=1)

    def test_rejects_pointer_without_sentinel(self):
        with self.assertRaises(ValueError):
            arm_autoclear.arm(SID, "hello", home=Path("/tmp"), now=1)

    def test_rewrite_replaces_flag_and_leaves_no_temp(self):
        with tempfile.TemporaryDirectory() as home:
            arm_autoclear.arm(SID, PTR, home=Path(home), now=1)
            p = arm_autoclear.arm(SID, PTR, home=Path(home), now=2)
            self.assertEqual(json.loads(p.read_text())["created_at"], 2)
            self.assertEqual([f.name for f in p.parent.iterdir()], [p.name])


if __name__ == "__main__":
    unittest.main()
