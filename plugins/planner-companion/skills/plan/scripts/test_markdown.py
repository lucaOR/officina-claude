import unittest

from testsupport import CliTestCase, fixture


class MarkdownTests(CliTestCase):
    def md(self, source=None):
        r = self.cli("md", self.write(source if source is not None else fixture()))
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout

    def test_plan_header(self):
        md = self.md()
        self.assertTrue(md.startswith(f"# {fixture()['title']} Implementation Plan\n\n**Goal:**"))
        for label in ("**Goal:**", "**Architecture:**", "**Tech Stack:**", "**Spec:**", "## Global Constraints", "## Review Focus", "## Decisions"):
            self.assertIn(label, md)

    def test_null_spec_renders_none(self):
        self.assertIn("**Spec:** none", self.md())
        s = fixture()
        s["spec"] = "docs/specs/x.md"
        self.assertIn("**Spec:** docs/specs/x.md", self.md(s))

    def test_settled_and_open_decisions(self):
        md = self.md()
        self.assertIn("### D2: ", md)
        self.assertIn("**Pick:** (a) SQLite — Queryable and local.", md)
        self.assertIn("**Open.** Recommended: (b) 30 days", md)
        self.assertLess(md.index("### D1: "), md.index("### D2: "))
        self.assertLess(md.index("### D2: "), md.index("### D4: "))
        self.assertNotIn("Fine up to a few million rows", md)

    def test_removed_elements_are_left_out(self):
        md = self.md()
        self.assertNotIn("### D3:", md)
        s = fixture()
        s["tasks"][1]["removed"] = {"note": "gone"}
        md = self.md(s)
        self.assertNotIn("### Task 2: ", md)
        self.assertIn("### Task 1: ", md)

    def test_task_sections(self):
        md = self.md()
        self.assertIn("### Task 2: ", md)
        self.assertIn("**Implements:** D2, D4", md)
        self.assertLess(md.index("### Task 1: "), md.index("### Task 2: "))
        self.assertIn("- [ ] **Step 1: ", md)
        self.assertIn("- Create: `src/Ask.php`", md)
        self.assertIn("- Test: `tests/AskTest.php`", md)
        self.assertIn("```php\nassertSame(400, $r->status());\n```", md)
        self.assertIn("Run: `php artisan test`", md)
        self.assertIn("Expected: FAIL", md)
        self.assertIn("```bash\nfeat: accept questions\n```", md)

    def test_review_focus_names_its_test(self):
        self.assertIn("- An empty question returns a clear error. Test: T1.", self.md())

    def test_review_focus_without_test(self):
        s = fixture()
        s["reviewFocus"] = [{"text": "Restart keeps answers."}]
        md = self.md(s)
        self.assertIn("- Restart keeps answers.\n", md)
        self.assertNotIn("Test:", md.split("## Decisions")[0].split("## Review Focus")[1])

    def test_after_orders_tasks_and_ignores_unknown(self):
        s = fixture()
        s["tasks"][0]["after"] = ["T2", "T9"]
        s["tasks"][1]["after"] = []
        md = self.md(s)
        self.assertLess(md.index("### Task 2: "), md.index("### Task 1: "))

    def test_after_cycle_does_not_hang(self):
        s = fixture()
        s["tasks"][0]["after"] = ["T2"]
        s["tasks"][1]["after"] = ["T1"]
        md = self.md(s)
        self.assertLess(md.index("### Task 1: "), md.index("### Task 2: "))

    def test_code_with_backtick_fences_round_trips(self):
        s = fixture()
        code = "Write this README:\n```bash\nmake test\n```\nand a ```` four-tick run too"
        s["tasks"][0]["steps"][0]["code"] = {"lang": "markdown", "text": code}
        s["tasks"][0]["commit"] = "docs: add ``` to the README"
        md = self.md(s)
        # Walk the CommonMark fences: an opening run of n backticks closes only on a bare run of >= n.
        blocks, outside, fence, body = [], [], None, []
        for line in md.split("\n"):
            run = len(line) - len(line.lstrip("`"))
            if fence is None and run >= 3:
                fence, body = run, []
            elif fence is not None and run >= fence and not line.strip("`").strip():
                blocks.append("\n".join(body))
                fence = None
            elif fence is not None:
                body.append(line)
            else:
                outside.append(line)
        self.assertIsNone(fence, "a fence is left open")
        self.assertIn(code, blocks)
        self.assertIn("docs: add ``` to the README", blocks)
        self.assertIn("\n`````markdown\n", md)  # one tick longer than the longest run in the text (4)
        self.assertIn("\n````bash\ndocs: add", md)
        self.assertIn("### Task 2: Store answers", outside)
        self.assertIn("feat: store answers", blocks)  # Task 2's own commit block still pairs up

    def test_help_lists_md(self):
        self.assertRegex(self.cli("--help").stdout, r"(?m)^md\s")


if __name__ == "__main__":
    unittest.main()
