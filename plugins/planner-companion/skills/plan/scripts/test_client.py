import re
import subprocess
import urllib.request

import test_server
from test_changes import ChangesTestCase
from testsupport import HERE

CLIENT = HERE / "page" / "client.js"


class ClientTest(ChangesTestCase):
    """The page client: it must parse, call only this server's /api/, and ship inside the served page."""

    # Reuse the server helpers without inheriting (and re-running) ServerTest's own tests.
    def env(self):
        env = super().env()
        env["PLANNING_PORT"] = "0"
        return env

    start = test_server.ServerTest.start
    kill_server = test_server.ServerTest.kill_server

    def test_client_parses(self):
        r = subprocess.run(["node", "--check", str(CLIENT)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_client_calls_only_its_own_api(self):
        text = CLIENT.read_text()
        calls = re.findall(r"fetch\(\s*([^,)]*)", text)
        self.assertTrue(calls, "client.js makes no fetch call")
        for arg in calls:
            self.assertRegex(arg.strip(), r"""^(['"`]/api/|api\()""", f"fetch({arg}) does not start with /api/")
        self.assertNotRegex(text, r"""['"`]https?://""")

    def test_served_page_inlines_the_client(self):
        self.start()
        req = urllib.request.Request(f"http://{self.host}/", headers={"Cookie": f"planning-key-{self.port}={self.key}"})
        with urllib.request.urlopen(req, timeout=60) as r:
            html = r.read().decode()
        marker = re.search(r"CLIENT_MARKER = '([^']+)'", CLIENT.read_text()).group(1)
        self.assertIn(marker, html)
