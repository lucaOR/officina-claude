import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import ledger  # noqa: E402
import paths  # noqa: E402

_HOOK = Path(__file__).resolve().parent / "inject-knowledge-digest.py"
_spec = importlib.util.spec_from_file_location("inject_knowledge_digest", _HOOK)
ikd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ikd)


class TestRent(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.prev = os.environ.get("KNOWLEDGE_LOCAL_DIR")
        os.environ["KNOWLEDGE_LOCAL_DIR"] = str(self.root / "local")

    def tearDown(self):
        if self.prev is None:
            os.environ.pop("KNOWLEDGE_LOCAL_DIR", None)
        else:
            os.environ["KNOWLEDGE_LOCAL_DIR"] = self.prev
        self.tmp.cleanup()

    def test_rent_path(self):
        self.assertEqual(ikd.rent_path(self.root),
                         self.root / "local" / "metrics" / "kb-digest-rent.jsonl")
        self.assertEqual(ikd.rent_path(self.root),
                         paths.metrics_file(self.root, "kb-digest-rent.jsonl"))

    def test_records_source_and_emitted_bytes(self):
        ikd.record_rent(self.root, "startup", "abcde")
        row = ledger.load_ledger(ikd.rent_path(self.root))[0]
        self.assertEqual(row["source"], "startup")
        self.assertEqual(row["bytes"], 5)
        self.assertTrue(row["ts"])

    def test_bytes_are_utf8_not_characters(self):
        # The digest carries em-dashes and accented service names. Counting characters
        # would under-report the cache write by however many multibyte glyphs it holds.
        ikd.record_rent(self.root, "startup", "—")
        self.assertEqual(ledger.load_ledger(ikd.rent_path(self.root))[0]["bytes"], 3)

    def test_compact_costs_less_than_startup(self):
        # This is the whole point of recording the emitted size rather than the digest
        # size: compact and resume get a dispatch preamble and a pointer, no digest.
        digest = "x" * 13000
        full = ikd.build_context("startup", digest)
        slim = ikd.build_context("compact", digest)
        self.assertLess(len(slim.encode("utf-8")), len(full.encode("utf-8")))

    def test_record_rent_is_fail_silent(self):
        ikd.record_rent(self.root / "\0bad", "startup", "abc")
