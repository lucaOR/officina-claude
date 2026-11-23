import http.client
import json
import os
import re
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from testsupport import CLI, HERE
from test_changes import ChangesTestCase


class ServerTest(ChangesTestCase):
    """Black-box tests of `start`/`stop` and the routes of server.mjs, on a free loopback port."""

    def env(self):
        env = super().env()
        env["PLANNING_PORT"] = "0"
        return env

    def start(self):
        info = self.cli_json("start", self.dir)
        sd = self.state_dir(self.dir)
        self.addCleanup(self.kill_server, sd)
        self.url = info["url"]
        parts = urlsplit(self.url)
        self.port = parts.port
        self.key = re.search(r"key=([0-9a-f]+)", self.url).group(1)
        self.host = f"127.0.0.1:{self.port}"
        return info

    def kill_server(self, sd):
        self.cli("stop", self.dir)
        try:
            pid = json.loads((sd / "server-info.json").read_text())["pid"]
        except (OSError, ValueError):
            return
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    def request(self, method, path, body=None, headers=None, cookie=True, key=True, origin=True, raw=None):
        h = dict(headers or {})
        if cookie and "Cookie" not in h:
            h["Cookie"] = f"planning-key-{self.port}={self.key}"
        if origin is True and method == "POST":
            h["Origin"] = f"http://{self.host}"
        elif origin:
            h["Origin"] = origin
        data = raw
        if body is not None:
            data = json.dumps(body).encode()
            h.setdefault("Content-Type", "application/json")
        req = urllib.request.Request(f"http://{self.host}{path}", data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, r.read(), r.headers
        except urllib.error.HTTPError as e:
            return e.code, e.read(), e.headers

    def post(self, path, body, **kw):
        status, data, _ = self.request("POST", path, body, **kw)
        return status, (json.loads(data) if data[:1] in (b"{", b"[") else data)

    def lines(self, name="questions.jsonl"):
        return [json.loads(l) for l in (self.dir / name).read_text().split("\n") if l.strip()]

    questions = lines

    def test_start_binds_loopback_and_reuses(self):
        first = self.start()
        self.assertFalse(first["reused"])
        self.assertEqual(urlsplit(first["url"]).hostname, "127.0.0.1")
        self.assertEqual(first["port"], self.port)
        second = self.cli_json("start", self.dir)
        self.assertTrue(second["reused"])
        self.assertEqual(second["port"], first["port"])
        sd = self.state_dir(self.dir)
        info = json.loads((sd / "server-info.json").read_text())
        self.assertEqual(set(info), {"pid", "port", "url", "planDir", "startedAt"})
        self.assertEqual(info["url"], first["url"])
        self.assertEqual((sd / "server-info.json").stat().st_mode & 0o777, 0o600)
        self.assertEqual((sd / "last-token").stat().st_mode & 0o777, 0o600)
        self.assertEqual((sd / "last-port").read_text().strip(), str(self.port))
        self.assertTrue((sd / "server.log").exists())

    def test_requests_without_key_are_403(self):
        self.start()
        status, _, headers = self.request("GET", "/", cookie=False)
        self.assertEqual(status, 403)
        self.assertEqual(headers["X-Frame-Options"], "DENY")
        self.assertEqual(self.post("/api/ask", {"kind": "comment", "target": "D1", "text": "x"}, cookie=False)[0], 403)
        self.assertEqual(self.request("GET", "/", cookie=False, headers={"Cookie": f"planning-key-{self.port}=" + "0" * 64})[0], 403)
        self.assertEqual(self.request("GET", "/?key=" + "0" * 64, cookie=False)[0], 403)
        self.assertEqual(self.questions(), [])

    def test_key_sets_cookie_and_serves_the_page(self):
        self.start()
        status, body, headers = self.request("GET", f"/?key={self.key}", cookie=False)
        self.assertEqual(status, 200)
        self.assertIn(f"planning-key-{self.port}={self.key}", headers["Set-Cookie"])
        self.assertIn("HttpOnly", headers["Set-Cookie"])
        self.assertIn("SameSite=Strict", headers["Set-Cookie"])
        self.assertNotIn(b'data-tab="overview"', body)
        status, body, headers = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b'data-tab="overview"', body)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["Referrer-Policy"], "no-referrer")
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])

    def test_page_is_live_and_matches_render(self):
        self.start()
        out = self.tmp / "page.html"
        self.cli_json("render", self.dir, "--out", out)
        _, body, _ = self.request("GET", "/")
        self.assertEqual(body.decode(), out.read_text())
        self.post("/api/pick", {"target": "D4", "option": "b"})
        _, body2, _ = self.request("GET", "/")
        self.assertNotEqual(body, body2)

    def test_unknown_route_is_404(self):
        self.start()
        self.assertEqual(self.request("GET", "/nope")[0], 404)
        self.assertEqual(self.post("/api/nope", {})[0], 404)

    def test_foreign_or_missing_origin_is_403(self):
        self.start()
        ask = {"kind": "comment", "target": "D1", "text": "x"}
        self.assertEqual(self.post("/api/ask", ask, origin="http://evil.example")[0], 403)
        self.assertEqual(self.post("/api/ask", ask, origin=f"http://localhost:{self.port}")[0], 403)
        self.assertEqual(self.post("/api/ask", ask, origin=False)[0], 403)
        self.assertEqual(self.questions(), [])

    def test_bad_requests_are_400_or_413(self):
        self.start()
        self.assertEqual(self.post("/api/ask", {"kind": "comment", "target": "D1"})[0], 400)
        self.assertEqual(self.post("/api/ask", {"kind": "shout", "target": "D1", "text": "x"})[0], 400)
        self.assertEqual(self.post("/api/pick", {"target": "D4"})[0], 400)
        status, _, _ = self.request("POST", "/api/ask", raw=b"{nope", headers={"Content-Type": "application/json"})
        self.assertEqual(status, 400)
        status, _, _ = self.request("POST", "/api/ask", raw=b"[]", headers={"Content-Type": "application/json"})
        self.assertEqual(status, 400)
        status, _, _ = self.request("POST", "/api/ask", raw=b"{}", headers={"Content-Type": "text/plain"})
        self.assertEqual(status, 400)
        status, _, _ = self.request("POST", "/api/ask", raw=b"{}")
        self.assertEqual(status, 400)
        big = json.dumps({"kind": "comment", "target": "D1", "text": "x" * 70000}).encode()
        status, _, _ = self.request("POST", "/api/ask", raw=big, headers={"Content-Type": "application/json"})
        self.assertEqual(status, 413)
        self.assertEqual(self.questions(), [])
        self.assertEqual(self.request("GET", "/")[0], 200)

    def test_oversized_body_is_cut_off_while_streaming(self):
        self.start()
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.putrequest("POST", "/api/ask")
        for k, v in {"Content-Type": "application/json", "Origin": f"http://{self.host}",
                     "Cookie": f"planning-key-{self.port}={self.key}", "Transfer-Encoding": "chunked"}.items():
            conn.putheader(k, v)
        conn.endheaders()
        chunk = b"x" * 8192
        try:
            for _ in range(64):  # 512 KB offered, never finishing the body
                conn.send(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
        except OSError:
            pass  # the server hung up on us, which is the point
        self.assertEqual(conn.getresponse().status, 413)
        conn.close()
        self.assertEqual(self.request("GET", "/")[0], 200)

    def test_ask_appends_a_question(self):
        self.start()
        status, body = self.post("/api/ask", {"kind": "comment", "target": "D1", "text": "why?"})
        self.assertEqual(status, 200)
        self.assertEqual((body["question"]["id"], body["thread"]["id"]), ("q1", "t1"))
        qs = self.questions()
        self.assertEqual((len(qs), qs[0]["kind"], qs[0]["text"], qs[0]["target"]), (1, "comment", "why?", "D1"))
        threads = self.read("threads.json")["threads"]
        self.assertEqual((len(threads), threads[0]["messages"][0]["text"]), (1, "why?"))

    def test_pick_settles_and_queues(self):
        self.start()
        status, body = self.post("/api/pick", {"target": "D4", "option": "b"})
        self.assertEqual(status, 200)
        self.assertEqual(self.decision("D4")["state"], "settled")
        q = self.questions()[0]
        self.assertEqual((q["kind"], q["change"], q["target"], q["option"]), ("pick", "c1", "D4", "b"))
        self.assertEqual(body["change"]["id"], "c1")

    def test_double_pick_same_option_creates_one_change(self):
        self.start()
        for _ in range(2):
            status, _ = self.post("/api/pick", {"target": "D4", "option": "b"})
            self.assertEqual(status, 200)
        self.assertEqual(len(self.changes()["log"]), 1)
        self.assertEqual(len(self.questions()), 1)

    def test_invalid_pick_is_422_with_diagnostics(self):
        self.start()
        status, body = self.post("/api/pick", {"target": "D4", "option": "zzz"})
        self.assertEqual(status, 422)
        self.assertTrue(body["diagnostics"])
        status, _ = self.post("/api/pick", {"target": "D99", "option": "a"})
        self.assertEqual(status, 422)
        self.assertEqual(self.questions(), [])

    def test_resolve_and_to_change(self):
        self.start()
        self.post("/api/ask", {"kind": "comment", "target": "D1", "text": "please change this"})
        status, body = self.post("/api/to-change", {"thread": "t1"})
        self.assertEqual(status, 200)
        self.assertEqual(body["question"]["kind"], "change")
        status, _ = self.post("/api/resolve", {"thread": "t1"})
        self.assertEqual(status, 200)
        self.assertEqual(self.read("threads.json")["threads"][0]["state"], "resolved")

    def test_undo_and_conflict_is_409(self):
        self.start()
        self.post("/api/pick", {"target": "D4", "option": "b"})
        self.apply({"upsert": [{**self.decision("D4"), "whyPick": "x"}]}, kind="change")
        status, body = self.post("/api/undo", {"change": "c1"})
        self.assertEqual(status, 409)
        self.assertEqual(body["conflict"][0]["id"], "c2")
        status, body = self.post("/api/undo", {"change": "c1", "withLater": True})
        self.assertEqual((status, body["undone"]), (200, ["c2", "c1"]))
        self.assertEqual(self.decision("D4")["state"], "open")
        status, body = self.post("/api/undo", {"change": "c9"})
        self.assertEqual(status, 422)

    def test_update_real_writes_plan_md(self):
        self.start()
        self.post("/api/pick", {"target": "D4", "option": "b"})
        status, body = self.post("/api/update-real", {})
        self.assertEqual((status, body["ok"]), (200, True))
        self.assertTrue((self.dir / "plan.md").read_text().startswith("# "))
        self.assertEqual(self.read("plan.json"), self.working())
        self.assertEqual(self.changes()["log"], [])

    def test_page_undo_queues_a_notice_but_cli_undo_does_not(self):
        self.start()
        self.post("/api/pick", {"target": "D4", "option": "b"})
        status, body = self.post("/api/undo", {"change": "c1"})
        self.assertEqual(status, 200, body)
        notice = self.questions()[-1]
        self.assertEqual(body["question"], notice)
        self.assertEqual((notice["id"], notice["kind"]), ("q2", "undo"))
        self.assertEqual(notice["undone"], [{"id": "c1", "summary": "Picked option b (30 days) for D4"}])
        self.assertEqual(notice["touched"], ["D4", "T2", "S2"])
        self.assertEqual(self.cli_json("next", self.dir)["id"], "q1")  # the pick, then the undo, in order
        self.assertEqual(self.request("GET", "/")[0], 200)  # a notice has no target and still renders
        self.cli_json("pick", self.dir, "D4", "a")
        self.cli_json("undo", self.dir, "c2")
        self.assertEqual(len(self.questions()), 2)

    def test_page_update_queues_a_notice_but_cli_update_does_not(self):
        self.start()
        status, body = self.post("/api/update-real", {})
        self.assertEqual(status, 200, body)
        notice = self.questions()[-1]
        self.assertEqual(body["question"], notice)
        self.assertEqual((notice["kind"], notice["wrote"]), ("update", ["plan.json", "plan.md"]))
        self.assertEqual(self.cli_json("next", self.dir), notice)  # next and watch see it like any question
        self.assertEqual(self.cli_json("watch", self.dir, "--interval-ms", "50"), notice)
        self.cli_json("ack", self.dir, notice["id"])
        self.cli_json("update", self.dir)
        self.assertEqual(len(self.questions()), 1)
        self.assertIsNone(self.cli_json("next", self.dir))

    def test_undo_dry_run_changes_nothing(self):
        self.start()
        self.post("/api/pick", {"target": "D4", "option": "b"})
        before = (self.working_bytes(), self.changes(), len(self.questions()))
        status, body = self.post("/api/undo", {"change": "c1", "dryRun": True})
        self.assertEqual((status, body["undone"], body["dryRun"]), (200, ["c1"], True))
        self.assertNotIn("question", body)
        self.apply({"upsert": [{**self.decision("D4"), "whyPick": "x"}]}, kind="change")
        status, body = self.post("/api/undo", {"change": "c1", "dryRun": True})
        self.assertEqual((status, body["conflict"][0]["id"]), (409, "c2"))
        self.assertEqual(len(self.questions()), before[2])
        self.assertEqual(self.decision("D4")["whyPick"], "x")

    def test_update_real_without_header_is_422_and_writes_nothing(self):
        self.start()
        self.apply({"set": {"goal": ""}}, kind="author")
        status, body = self.post("/api/update-real", {})
        self.assertEqual(status, 422)
        self.assertEqual([(d["code"], d["path"]) for d in body["diagnostics"]], [("header-missing", "goal")])
        self.assertIn("the real plan needs goal", body["diagnostics"][0]["message"])
        self.assertFalse((self.dir / "plan.md").exists())
        self.assertEqual(self.questions(), [])

    def test_foreign_host_is_403_even_with_the_key(self):
        self.start()
        ask = {"kind": "comment", "target": "D1", "text": "x"}
        evil = {"Host": "evil.example"}
        self.assertEqual(self.request("GET", "/", headers=evil)[0], 403)
        self.assertEqual(self.request("GET", f"/?key={self.key}", headers=evil, cookie=False)[0], 403)
        self.assertEqual(self.post("/api/ask", ask, headers=evil, origin="http://evil.example")[0], 403)
        self.assertEqual(self.post("/api/ask", ask, headers={"Host": f"127.0.0.1:{self.port + 1}"},
                                   origin=f"http://127.0.0.1:{self.port + 1}")[0], 403)
        self.assertEqual(self.questions(), [])
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("GET", f"/ws?key={self.key}", headers={"Host": "evil.example", "Connection": "Upgrade", "Upgrade": "websocket",
                                                           "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ=="})
        try:
            self.assertNotEqual(conn.getresponse().status, 101)
        except (http.client.RemoteDisconnected, ConnectionError):
            pass  # socket destroyed without a handshake
        conn.close()
        local = {"Host": f"localhost:{self.port}"}
        self.assertEqual(self.request("GET", "/", headers=local)[0], 200)
        self.assertEqual(self.post("/api/ask", ask, headers=local, origin=f"http://localhost:{self.port}")[0], 200)

    def test_concurrent_asks_are_all_kept_in_order(self):
        self.start()
        texts = [f"ask {i}" for i in range(6)]
        replies = []

        def send(text, barrier):
            barrier.wait()
            replies.append(self.post("/api/ask", {"kind": "comment", "target": "D1", "text": text}))

        for pair in (texts[0:2], texts[2:4], texts[4:6]):
            barrier = threading.Barrier(len(pair))
            workers = [threading.Thread(target=send, args=(t, barrier)) for t in pair]
            for w in workers:
                w.start()
            for w in workers:
                w.join(timeout=30)
        self.assertEqual([status for status, _ in replies], [200] * 6)
        self.assertEqual(sorted(body["question"]["id"] for _, body in replies), sorted(f"q{i}" for i in range(1, 7)))
        qs = self.questions()
        self.assertEqual([q["id"] for q in qs], [f"q{i}" for i in range(1, 7)])
        self.assertEqual(sorted(q["text"] for q in qs), texts)
        thread = self.read("threads.json")["threads"]
        self.assertEqual(len(thread), 1)  # every comment joined the one open thread on D1
        self.assertEqual([(m["question"], m["text"]) for m in thread[0]["messages"]], [(q["id"], q["text"]) for q in qs])
        self.assertEqual(self.cli_json("next", self.dir)["id"], "q1")

    def test_thrown_lib_error_is_500_json_and_server_keeps_serving(self):
        self.start()
        status, body = self.post("/api/resolve", {"thread": "t77"})
        self.assertEqual(status, 500)
        self.assertIn("unknown thread", body["error"])
        status, body = self.post("/api/ask", {"kind": "comment", "target": "D1", "text": "still alive"})
        self.assertEqual(status, 200)
        self.assertEqual(self.request("GET", "/")[0], 200)

    WS_CLIENT = r"""
const url = process.argv[1];
const ws = new WebSocket(url);
ws.onopen = () => console.log('open');
ws.onmessage = e => { console.log(e.data); process.exit(0); };
ws.onerror = () => { console.log('error'); process.exit(3); };
setTimeout(() => { console.log('timeout'); process.exit(2); }, 20000);
"""

    def ws_client(self, url):
        p = subprocess.Popen(["node", "-e", self.WS_CLIENT, url], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, env=self.env())
        self.addCleanup(lambda: (p.kill(), p.wait(), p.stdout.close(), p.stderr.close()))
        self.assertEqual(p.stdout.readline().strip(), "open")
        return p

    def test_file_change_pushes_reload(self):
        self.start()
        p = self.ws_client(f"ws://{self.host}/ws?key={self.key}")
        (self.dir / "working.json").touch()
        self.assertEqual(json.loads(p.stdout.readline()), {"type": "reload"})

    def test_lock_and_temp_files_do_not_push_reload(self):
        self.start()
        p = self.ws_client(f"ws://{self.host}/ws?key={self.key}")
        (self.dir / ".lock").mkdir()
        (self.dir / ".lock").rmdir()
        (self.dir / "working.json.123.abcd1234.tmp").write_text("x")
        time.sleep(0.6)
        (self.dir / "threads.json").touch()  # a real change right after: the first message must be this reload
        self.assertEqual(json.loads(p.stdout.readline()), {"type": "reload"})
        p.kill()
        # a lone lock cycle never wakes the client: the process only ever printed one reload line
        self.assertEqual(p.stdout.read(), "")

    def test_websocket_needs_key_and_own_origin(self):
        self.start()
        for url, headers in ((f"/ws", {}), (f"/ws?key={self.key}", {"Origin": "http://evil.example"})):
            conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
            conn.request("GET", url, headers={"Connection": "Upgrade", "Upgrade": "websocket", "Sec-WebSocket-Version": "13",
                                              "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", **headers})
            try:
                resp = conn.getresponse()
                self.assertNotEqual(resp.status, 101)
            except (http.client.RemoteDisconnected, ConnectionError):
                pass  # socket destroyed without a handshake
            conn.close()

    def test_stop_removes_server_info(self):
        self.start()
        info = self.state_dir(self.dir) / "server-info.json"
        self.assertTrue(info.exists())
        pid = json.loads(info.read_text())["pid"]
        self.assertEqual(self.cli_json("stop", self.dir), {"status": "stopped"})
        self.assertFalse(info.exists())
        with self.assertRaises(ProcessLookupError):
            for _ in range(50):
                os.kill(pid, 0)
                time.sleep(0.1)
            self.fail("server still running")
        self.assertEqual(self.cli_json("stop", self.dir), {"status": "not_running"})

    def test_sigterm_removes_server_info_and_watch_exits_4(self):
        self.start()
        info = self.state_dir(self.dir) / "server-info.json"
        pid = json.loads(info.read_text())["pid"]
        os.kill(pid, signal.SIGTERM)
        r = self.cli("watch", self.dir, "--interval-ms", "50")
        self.assertEqual(r.returncode, 4, r.stdout + r.stderr)
        self.assertFalse(info.exists())

    def test_idle_timeout_removes_server_info(self):
        env = self.env()
        env["PLANNING_IDLE_TIMEOUT_MS"] = "300"
        env["PLANNING_LIFECYCLE_CHECK_MS"] = "100"
        r = subprocess.run(["node", str(CLI), "start", str(self.dir)], capture_output=True, text=True, env=env, cwd=self.tmp, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        sd = self.state_dir(self.dir)
        self.addCleanup(self.kill_server, sd)
        for _ in range(100):
            if not (sd / "server-info.json").exists():
                break
            time.sleep(0.1)
        self.assertFalse((sd / "server-info.json").exists())

    def test_restart_keeps_port_and_key(self):
        first = self.start()
        self.cli_json("stop", self.dir)
        env = self.env()
        env["PLANNING_PORT"] = str(first["port"])
        r = subprocess.run(["node", str(CLI), "start", str(self.dir)], capture_output=True, text=True, env=env, cwd=self.tmp, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        again = json.loads(r.stdout)
        self.assertEqual((again["port"], again["url"]), (first["port"], first["url"]))

    def test_stop_ignores_a_foreign_pid(self):
        sd = self.state_dir(self.dir)
        sd.mkdir(parents=True)
        sleeper = subprocess.Popen(["sleep", "30"])
        self.addCleanup(lambda: (sleeper.kill(), sleeper.wait()))
        (sd / "server-info.json").write_text(json.dumps({"pid": sleeper.pid, "port": 1, "url": "x", "planDir": str(self.dir), "startedAt": "x"}))
        self.assertEqual(self.cli_json("stop", self.dir), {"status": "not_running"})
        self.assertIsNone(sleeper.poll())

    def test_help_lists_start_and_stop(self):
        out = self.cli("--help").stdout.splitlines()
        for name in ("start", "stop"):
            self.assertTrue(any(l.startswith(name + " ") for l in out), name)

    def test_no_outbound_network_in_sources(self):
        files = [HERE / "planning.mjs", HERE / "server.mjs", *sorted((HERE / "lib").glob("*.mjs")),
                 *sorted(p for p in (HERE / "page").rglob("*") if p.is_file() and "test" not in p.parts)]
        self.assertIn(HERE / "server.mjs", files)
        url = re.compile(r"""(?:https?|wss?)://([^\s'"`/:\\)]*)""", re.I)
        for f in files:
            text = f.read_text()
            if f.suffix == ".mjs" or f.suffix == ".js":
                text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
                text = re.sub(r"(?m)^\s*//.*$", "", text)
                text = re.sub(r"(?<![:'\"`\\])//[^\n]*", "", text)
            self.assertNotIn("primeradiant", text.lower(), f.name)
            for m in url.finditer(text):
                if m.group(1).startswith("${"):
                    continue  # a template-built origin, not a literal host
                self.assertIn(m.group(1), ("127.0.0.1", "localhost"), f"{f.name}: {m.group(0)}")
