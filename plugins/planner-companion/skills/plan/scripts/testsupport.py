"""Shared helpers for the planning plugin's CLI black-box tests."""
import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
CLI = HERE / "planning.mjs"


def fixture(name="minimal"):
    """Load a JSON fixture from scripts/fixtures/<name>.json."""
    return json.loads((HERE / "fixtures" / f"{name}.json").read_text())


def state_dir(plan_dir, env=None):
    """The server state dir of a plan folder (same rule as store.mjs stateDir), from env or os.environ."""
    env = os.environ if env is None else env
    base = env.get("XDG_STATE_HOME") or str(Path(env.get("HOME") or Path.home()) / ".local" / "state")
    digest = hashlib.sha256(str(Path(plan_dir).resolve()).encode()).hexdigest()[:12]
    return Path(base) / "planning" / digest


class CliTestCase(unittest.TestCase):
    """Runs planning.mjs as a child process with HOME and XDG_STATE_HOME inside self.tmp."""

    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self.tmp = Path(self._td.name)
        (self.tmp / "home").mkdir()
        self._n = 0

    def env(self):
        env = dict(os.environ)
        env["HOME"] = str(self.tmp / "home")
        env["XDG_STATE_HOME"] = str(self.tmp / "state")
        return env

    def state_dir(self, plan_dir):
        """The state dir the CLI will use for plan_dir, under self.env()."""
        return state_dir(plan_dir, self.env())

    def cli(self, *args):
        return subprocess.run(["node", str(CLI), *map(str, args)], capture_output=True, text=True,
                              env=self.env(), cwd=self.tmp, timeout=180)

    def cli_json(self, *args):
        r = self.cli(*args)
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        return json.loads(r.stdout)

    def write(self, obj):
        self._n += 1
        p = self.tmp / f"obj{self._n}.json"
        p.write_text(json.dumps(obj))
        return str(p)
