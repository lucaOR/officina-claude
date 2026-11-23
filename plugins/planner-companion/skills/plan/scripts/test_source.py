import copy
import json
import unittest

from testsupport import CliTestCase, fixture


class SourceTests(CliTestCase):
    def validate(self, source, previous=None):
        args = ["validate", self.write(source)]
        if previous is not None:
            args += ["--previous", self.write(previous)]
        r = self.cli(*args)
        out = json.loads(r.stdout)
        self.assertEqual(r.returncode, 0 if out["ok"] else 1)
        return out

    def codes(self, source, previous=None):
        return [(d["code"], d["path"]) for d in self.validate(source, previous)["diagnostics"]]

    def code_names(self, source, previous=None):
        return [c for c, _ in self.codes(source, previous)]

    def test_fixture_is_valid(self):
        self.assertEqual(self.validate(fixture())["diagnostics"], [])

    def test_mandatory_slots(self):
        for slot in ("scale", "dataFrom"):
            s = fixture()
            del s["decisions"][0]["slots"][slot]
            self.assertIn(("slot-missing", f"decisions[D1].slots.{slot}"), self.codes(s))

    def test_settled_needs_pick_and_open_needs_recommended(self):
        s = fixture()
        del s["decisions"][0]["pick"]
        del s["decisions"][3]["recommended"]
        codes = self.codes(s)
        self.assertIn(("pick-missing", "decisions[D1].pick"), codes)
        self.assertIn(("recommended-missing", "decisions[D4].recommended"), codes)

    def test_pick_must_be_an_option(self):
        s = fixture()
        s["decisions"][1]["pick"] = "z"
        self.assertIn("pick-unknown", self.code_names(s))

    def test_dangling_reference(self):
        s = fixture()
        s["tasks"][0]["decisions"] = ["D99"]
        s["summary"][0] = "see S9"
        refs = [c for c in self.codes(s) if c[0] == "ref-unknown"]
        self.assertEqual(len(refs), 2)

    def test_removed_exempt_but_replaced_by_checked(self):
        s = fixture()
        self.assertEqual(self.validate(s)["diagnostics"], [])
        s["decisions"][2]["removed"]["replacedBy"] = ["D77"]
        self.assertIn(("ref-unknown", "decisions[D3].removed.replacedBy"), self.codes(s))

    def test_null_domain_is_valid(self):
        s = fixture()
        s["decisions"][0]["domain"] = None
        self.assertEqual(self.validate(s)["diagnostics"], [])

    def test_unknown_domain_and_diagram_type(self):
        s = fixture()
        s["decisions"][0]["domain"] = "nope"
        s["domains"][0]["diagram"]["type"] = "tree"
        names = self.code_names(s)
        self.assertIn("domain-unknown", names)
        self.assertIn("diagram-type", names)

    def test_domain_ids_are_unique_slugs(self):
        s = fixture()
        s["domains"][0]["id"] = "Ask it"
        s["domains"].append(copy.deepcopy(s["domains"][1]))
        codes = self.codes(s)
        self.assertIn(("domain-id-format", "domains[Ask it].id"), codes)
        self.assertIn(("id-duplicate", "domains[store]"), codes)

    def test_id_above_counter(self):
        s = fixture()
        d = copy.deepcopy(s["decisions"][0])
        d["id"] = "D5"
        s["decisions"].append(d)
        self.assertIn("id-counter", self.code_names(s))

    def test_append_only_against_previous(self):
        prev, cur = fixture(), fixture()
        cur["decisions"] = [d for d in cur["decisions"] if d["id"] != "D3"]
        self.assertIn("id-dropped", self.code_names(cur, previous=prev))

    def test_counter_never_decreases(self):
        prev, cur = fixture(), fixture()
        cur["counters"]["T"] = 1
        self.assertIn("counter-decreased", self.code_names(cur, previous=prev))

    def test_index(self):
        idx = self.cli_json("index", self.write(fixture()))
        self.assertIn("T1", idx["D1"]["uses"])
        self.assertIn("summary", idx["D4"]["uses"])
        self.assertTrue(idx["D3"]["removed"])
        self.assertEqual(idx["D3"]["replacedBy"], ["D4"])
        self.assertEqual(idx["D1"]["tab"], "ask")
        self.assertEqual(idx["T1"]["tab"], "overview")

    def test_help_lists_validate_and_index(self):
        first = [l.split()[:1] for l in self.cli("--help").stdout.splitlines()]
        self.assertIn(["validate"], first)
        self.assertIn(["index"], first)

    def test_diagrams_in_fixture_render(self):
        s = fixture()
        specs = [dict(s["flow"], type="sequence", id="flow"), dict(s["entities"], type="erd", id="ent")]
        specs += [dict(d["diagram"], id="wf-" + d["id"]) for d in s["domains"]]
        for spec in specs:
            out = self.cli_json("diagram", self.write(spec))
            self.assertTrue(out["ok"])


if __name__ == "__main__":
    unittest.main()
