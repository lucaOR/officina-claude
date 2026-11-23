"""Black-box tests for block-external-reads.py. Plain stdlib unittest.

The hook only resolves paths, it never opens them, so the project, HOME and the outside
world can all be invented paths under /srv. That keeps every "allowed" case allowed for one
reason only: a temporary directory under /tmp/claude-* would be allowed as a scratchpad too.
"""
import unittest

from testkit import decision, run_hook

HOOK = "block-external-reads.py"
PROJECT = "/srv/project"
HOME = "/srv/home"
OUTSIDE = "/srv/outside/notes.txt"
SCRATCH = "/tmp/claude-1000/-srv-project/session/scratchpad"


def read(path):
    return {"hook_event_name": "PreToolUse", "tool_name": "Read",
            "tool_input": {"file_path": path}}


def bash(command):
    return {"hook_event_name": "PreToolUse", "tool_name": "Bash",
            "tool_input": {"command": command}}


class BlockExternalReadsTest(unittest.TestCase):
    def hook(self, payload, enabled=True):
        env = {"CLAUDE_PROJECT_DIR": PROJECT}
        if enabled:
            env["EXTERNAL_READ_ENABLE"] = "1"
        out, proc = run_hook(HOOK, payload, HOME, **env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return decision(out)

    def test_it_is_off_unless_enabled(self):
        self.assertIsNone(self.hook(read(OUTSIDE), enabled=False))
        self.assertIsNone(self.hook(bash("cat " + OUTSIDE), enabled=False))

    def test_a_read_outside_the_project_is_denied(self):
        self.assertEqual(self.hook(read(OUTSIDE)), "deny")

    def test_a_read_inside_the_project_passes(self):
        self.assertIsNone(self.hook(read(PROJECT + "/src/app.py")))

    def test_a_read_under_claude_home_passes(self):
        self.assertIsNone(self.hook(read(HOME + "/.claude/projects/x/memory/MEMORY.md")))

    def test_a_read_in_the_scratchpad_passes(self):
        self.assertIsNone(self.hook(read(SCRATCH + "/notes.txt")))

    def test_a_sibling_whose_name_extends_the_project_is_outside(self):
        self.assertEqual(self.hook(read(PROJECT + "-old/app.py")), "deny")

    def test_a_dump_command_on_an_outside_path_is_denied(self):
        self.assertEqual(self.hook(bash("head -n 20 " + OUTSIDE)), "deny")

    def test_a_dump_command_later_in_a_chain_is_denied(self):
        self.assertEqual(self.hook(bash("ls && cat " + OUTSIDE)), "deny")

    def test_a_relative_path_is_never_inspected(self):
        self.assertIsNone(self.hook(bash("cat notes.txt")))

    def test_a_search_command_is_not_a_dump_command(self):
        self.assertIsNone(self.hook(bash("grep -n TODO " + OUTSIDE)))

    def test_a_sed_address_range_is_not_a_path(self):
        self.assertIsNone(self.hook(bash("sed -n '/usr/,/etc/p' notes.txt")))

    def test_a_sed_script_file_is_still_a_path(self):
        self.assertEqual(self.hook(bash("sed -f /srv/outside/edit.sed notes.txt")), "deny")

    def test_a_heredoc_body_is_not_a_path(self):
        self.assertIsNone(self.hook(bash("cat <<'EOF' > notes.txt\n/usr/local/bin/x\nEOF")))

    def test_copying_outside_material_into_the_scratchpad_passes(self):
        self.assertIsNone(self.hook(bash("cp {0} {1}/".format(OUTSIDE, SCRATCH))))

    def test_copying_outside_material_into_the_project_is_denied(self):
        self.assertEqual(self.hook(bash("cp {0} {1}/docs/".format(OUTSIDE, PROJECT))), "deny")

    def test_malformed_stdin_fails_open(self):
        out, proc = run_hook(HOOK, "{not json", HOME, EXTERNAL_READ_ENABLE=1)
        self.assertEqual(proc.returncode, 0)
        self.assertIsNone(out)


if __name__ == "__main__":
    unittest.main()
