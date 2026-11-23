import copy
import json
import re
from html.parser import HTMLParser

from testsupport import HERE, fixture
from test_changes import ChangesTestCase

VOID = {"meta", "link", "br", "hr", "img", "input", "path", "rect", "circle", "line", "use", "stop", "polygon", "polyline", "ellipse"}


class Node:
    def __init__(self, tag, attrs, parent=None):
        self.tag, self.attrs, self.parent, self.children = tag, dict(attrs), parent, []

    def text(self):
        return "".join(c if isinstance(c, str) else c.text() for c in self.children)

    def walk(self):
        for c in self.children:
            if isinstance(c, Node):
                yield c
                yield from c.walk()

    def cls(self):
        return (self.attrs.get("class") or "").split()

    def find_all(self, tag=None, cls=None, **attrs):
        want = {k.replace("_", "-"): v for k, v in attrs.items()}

        def ok(n):
            if tag and n.tag != tag:
                return False
            if cls and cls not in n.cls():
                return False
            for k, v in want.items():
                if k not in n.attrs or (v is not True and n.attrs[k] != v):
                    return False
            return True
        return [n for n in self.walk() if ok(n)]

    def find(self, *a, **kw):
        found = self.find_all(*a, **kw)
        return found[0] if found else None

    def inside(self, tag):
        n = self.parent
        while n:
            if n.tag == tag:
                return True
            n = n.parent
        return False


class Page(HTMLParser):
    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.root = Node("#root", {})
        self.cur = self.root
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        n = Node(tag, attrs, self.cur)
        self.cur.children.append(n)
        if tag not in VOID:
            self.cur = n

    def handle_startendtag(self, tag, attrs):
        self.cur.children.append(Node(tag, attrs, self.cur))

    def handle_endtag(self, tag):
        n = self.cur
        while n is not self.root and n.tag != tag:
            n = n.parent
        if n is not self.root:
            self.cur = n.parent

    def handle_data(self, data):
        self.cur.children.append(data)


def one_domain(src):
    src = copy.deepcopy(src)
    src["domains"] = src["domains"][:1]
    src["flow"]["phaseDomains"] = {"Ask": "ask", "Store": "ask"}
    for coll in ("decisions", "scenarios"):
        for e in src[coll]:
            e["domain"] = "ask" if e.get("domain") else e.get("domain")
    return src


class PageTest(ChangesTestCase):
    n_plans = 0

    def load(self, src):
        """A fresh plan folder holding src (via an author patch); returns its path."""
        PageTest.n_plans += 1
        old, self.dir = self.dir, self.init_plan(f"variant{PageTest.n_plans}")
        patch = {"set": {k: v for k, v in src.items() if k not in ("decisions", "tasks", "scenarios", "slug")},
                 "upsert": src["decisions"] + src["tasks"] + src["scenarios"]}
        self.apply(patch, kind="author")
        return self.dir

    def render(self, src=None, raw=False):
        if src is not None:
            self.load(src)
        out = self.tmp / "page.html"
        r = self.cli("render", self.dir, "--out", out)
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        html = out.read_text()
        return html if raw else Page(html).root

    def page(self):
        return self.render()

    def ask_server_up(self):
        info = self.state_dir(self.dir) / "server-info.json"
        info.parent.mkdir(parents=True, exist_ok=True)
        info.write_text(json.dumps({"port": 1, "key": "k", "pid": 1}))

    def card(self, code, root=None):
        root = root or self.page()
        found = root.find(id=code)
        self.assertIsNotNone(found, f"no element with id={code}")
        return found

    def test_tabs(self):
        root = self.page()
        self.assertEqual([n.attrs["data-tab"] for n in root.find_all(data_tab=True)],
                         ["overview", "ask", "store", "entities", "index"])
        self.assertEqual(sorted(n.attrs["data-tab-panel"] for n in root.find_all(data_tab_panel=True)),
                         sorted(["overview", "ask", "store", "entities", "index"]))

    def test_one_domain_has_no_domain_tabs(self):
        root = self.render(one_domain(fixture()))
        self.assertEqual([n.attrs["data-tab"] for n in root.find_all(data_tab=True)], ["overview", "entities", "index"])
        overview = root.find(data_tab_panel="overview")
        for code in ("D1", "D2", "D4", "S1", "S2"):
            self.assertIsNotNone(overview.find(id=code), code)
        self.assertIsNotNone(overview.find(data_ask_target="check:ask.1"))
        self.assertIsNotNone(overview.find(data_diagram="domain-ask"))
        for link in overview.find_all(cls="phase-link"):
            self.assertEqual(link.attrs["href"], "#overview")

    def test_card_slots_and_hidden_footer(self):
        card = self.card("D1").text()
        self.assertIn("At scale / if it fails", card)
        self.assertIn("Data from", card)
        self.assertIn("Hidden: User sees, Names, Drags along, Terms", card)

    def test_slot_shown_when_present_and_dropped_from_footer(self):
        src = fixture()
        src["decisions"][0]["slots"]["userSees"] = "A 400 banner."
        card = self.card("D1", self.render(src)).text()
        self.assertIn("A 400 banner.", card)
        self.assertIn("Hidden: Names, Drags along, Terms", card)

    def test_more_context_is_collapsed(self):
        more = self.card("D1").find("details", cls="more")
        self.assertIsNotNone(more)
        self.assertNotIn("open", more.attrs)
        self.assertIn("src/Ask.php:12", more.text())
        self.assertIsNotNone(more.find("a", cls="code", data_code="T1"))

    def test_codes_link_with_their_meaning(self):
        root = self.page()
        panel = root.find(data_tab_panel="overview")
        links = [a for a in panel.find_all("a", cls="code") if a.attrs["data-code"] == "D4"]
        self.assertTrue(links)
        for a in links:
            self.assertEqual((a.attrs["href"], a.attrs["title"]), ("#D4", "D4: Retention of answers"))
        t1 = [a for a in root.find_all("a", cls="code") if a.attrs["data-code"] == "T1"]
        self.assertEqual({a.attrs["title"] for a in t1}, {"T1: Accept questions"})

    def test_open_card_offers_picks(self):
        card = self.card("D4")
        picks = card.find_all("button", data_pick="D4")
        self.assertEqual([b.attrs["data-option"] for b in picks], ["a", "b"])
        self.assertEqual([("data-recommended" in b.attrs) for b in picks], [False, True])
        self.assertEqual(self.card("D1").find_all("button", data_pick=True), [])

    def test_index_strikes_a_removed_code(self):
        index = self.page().find(data_tab_panel="index")
        row = index.find("tr", id="D3")
        self.assertIsNotNone(row)
        self.assertIsNotNone(row.find("s"))
        self.assertIn("replaced by D4", row.text())
        self.assertIsNotNone(row.find("a", cls="code", data_code="D4"))
        live = [r for r in index.find_all("tr") if "Reject empty questions" in r.text()][0]
        self.assertIsNone(live.find("s"))
        self.assertIsNone(live.attrs.get("id"))
        self.assertIsNone(self.page().find(cls="card", id="D3"))

    def test_changed_card_shows_old_pick(self):
        self.cli_json("pick", self.dir, "D2", "b")
        root = self.page()
        d2 = self.card("D2", root)
        old = d2.find("s", cls="old-pick")
        self.assertIn("SQLite", old.text())
        self.assertIn("Files", d2.find(cls="opt", data_opt_state="picked").text())
        self.assertIn("changed", d2.find(cls="changed").text())
        t2 = self.card("T2", root)
        self.assertIn("re-check", t2.find(cls="recheck").text())
        self.assertIsNone(self.card("D1", root).find(cls="changed"))

    def test_old_pick_hidden_when_back_to_the_real_pick(self):
        self.cli_json("pick", self.dir, "D2", "b")
        self.cli_json("pick", self.dir, "D2", "a")
        d2 = self.card("D2")
        self.assertIsNone(d2.find("s", cls="old-pick"))

    def test_every_element_is_askable(self):
        targets = {n.attrs["data-ask-target"] for n in self.page().find_all(data_ask_target=True)}
        for t in ("D1", "D4", "T1", "T2", "S1", "S2", "rule:1", "summary:1", "summary:3", "check:ask.1",
                  "check:store.1", "focus:1"):
            self.assertIn(t, targets)

    def test_pending_question_marks_its_element(self):
        self.ask_server_up()
        self.cli_json("ask", self.dir, "comment", "D1", "why?")
        root = self.page()
        self.assertIn("data-pending", self.card("D1", root).attrs)
        self.assertNotIn("data-pending", self.card("D2", root).attrs)

    def test_waiting_marker_matches_the_client(self):
        self.ask_server_up()
        self.cli_json("ask", self.dir, "comment", "D1", "why?")
        rendered = self.card("D1").find(cls="wait").text()
        client = re.search(r"class: 'wait', text: '([^']+)'", (HERE / "page" / "client.js").read_text()).group(1)
        self.assertEqual((rendered, client), ("Waiting for Claude.", "Waiting for Claude."))

    def test_phases_link_to_their_domain(self):
        panel = self.page().find(data_tab_panel="overview")
        links = {a.text().strip(): a for a in panel.find_all("a", cls="phase-link")}
        self.assertEqual(links["Ask"].attrs["data-tab-link"], "ask")
        self.assertEqual(links["Store"].attrs["data-tab-link"], "store")
        self.assertEqual(links["Store"].attrs["href"], "#store")

    def test_task_cards_under_the_task_graph(self):
        panel = self.page().find(data_tab_panel="overview")
        self.assertIsNotNone(panel.find(data_diagram="tasks"))
        self.assertIsNotNone(panel.find("article", id="T1"))
        self.assertIsNotNone(panel.find("article", id="T2"))

    def test_diagram_ids_are_prefixed_per_spec(self):
        html = self.render(raw=True)
        for prefix in ("pl-flow-", "pl-domain-ask-", "pl-domain-store-", "pl-entities-", "pl-tasks-"):
            self.assertIn(f'id="{prefix}', html, prefix)

    def test_broken_diagram_does_not_blank_page(self):
        s = fixture()
        s["domains"][0]["diagram"]["rows"] = [["a > missing", ""]]
        html = self.render(s, raw=True)
        self.assertIn('class="diagram-error"', html)
        self.assertIn('id="D1"', html)

    def test_phase_bands_and_node_attributes_for_hover(self):
        html = self.render(raw=True)
        self.assertIn("data-segment-id=", html)
        self.assertIn("data-node-id=", html)

    def test_cards_list_their_nodes(self):
        self.assertEqual(self.card("D1").attrs["data-nodes"], "api")

    def test_thread_sits_inside_its_element_with_inert_controls(self):
        self.ask_server_up()
        self.cli_json("ask", self.dir, "comment", "D1", "why?")
        self.cli_json("answer", self.dir, "q1", "--text", "because", "--suggest-change")
        root = self.page()
        thread = self.card("D1", root).find(data_thread="t1")
        self.assertIsNotNone(thread)
        self.assertIn("because", thread.text())
        self.assertIsNotNone(thread.find(data_action="resolve"))
        self.assertIn("suggested", thread.find(data_action="to-change").cls())

    def test_to_change_not_suggested_without_a_suggestion(self):
        self.ask_server_up()
        self.cli_json("ask", self.dir, "comment", "D1", "why?")
        thread = self.page().find(data_thread="t1")
        self.assertNotIn("suggested", thread.find(data_action="to-change").cls())

    def test_resolved_thread_is_collapsed(self):
        self.ask_server_up()
        self.cli_json("ask", self.dir, "comment", "D1", "why?")
        self.cli_json("resolve", self.dir, "t1")
        thread = self.page().find(data_thread="t1")
        self.assertEqual(thread.tag, "details")
        self.assertNotIn("open", thread.attrs)

    def test_node_thread_renders_below_its_diagram(self):
        self.ask_server_up()
        self.cli_json("ask", self.dir, "comment", "node:domain-ask.api", "what is this?")
        fig = self.page().find(data_diagram="domain-ask")
        self.assertIsNotNone(fig.find(data_thread="t1"))

    def test_unplaced_thread_goes_to_other_threads(self):
        self.ask_server_up()
        self.cli_json("ask", self.dir, "comment", "D99", "lost?")
        root = self.page()
        other = root.find(data_tab_panel="overview").find(cls="other-threads")
        self.assertIsNotNone(other.find(data_thread="t1"))

    def test_changes_drawer_lists_newest_first_with_undo(self):
        self.cli_json("pick", self.dir, "D2", "b")
        self.cli_json("pick", self.dir, "D4", "a")
        rows = self.page().find_all(data_change=True)
        self.assertEqual([r.attrs["data-change"] for r in rows], ["c2", "c1"])
        self.assertIn("D4", rows[0].text())
        self.assertIsNotNone(rows[0].find(data_action="undo"))
        self.assertIsNotNone(rows[1].find("a", cls="code", data_code="D2"))

    def test_update_button(self):
        self.assertIsNotNone(self.page().find(data_action="update-real"))

    def test_source_text_is_escaped(self):
        s = fixture()
        s["decisions"][0]["title"] = '<img src=x onerror=alert(1)> "q"'
        s["summary"][0] = "<script>alert(2)</script>"
        html = self.render(s, raw=True)
        self.assertNotIn("<img src=x", html)
        self.assertNotIn("<script>alert(2)", html)
        root = Page(html).root
        self.assertIn('<img src=x onerror=alert(1)> "q"', self.card("D1", root).text())

    def test_no_anchor_inside_an_anchor(self):
        self.ask_server_up()
        self.cli_json("pick", self.dir, "D2", "b")
        self.cli_json("ask", self.dir, "comment", "D1", "see D2")
        html = self.render(raw=True)
        outer = self

        class Check(HTMLParser):
            depth = 0
            bad = []

            def handle_starttag(self, tag, attrs):
                if tag != "a":
                    return
                if self.depth:
                    self.bad.append(dict(attrs).get("class") or dict(attrs).get("href"))
                self.depth += 1

            def handle_endtag(self, tag):
                if tag == "a" and self.depth:
                    self.depth -= 1
        check = Check()
        check.feed(html)
        outer.assertEqual(check.bad, [])
        tile = Page(html).root.find(cls="tile")
        self.assertNotEqual(tile.tag, "a")
        self.assertIsNotNone(tile.find("a", data_tab_link=True))

    def test_thread_message_and_change_summary_are_escaped(self):
        self.ask_server_up()
        payload = "<img src=x onerror=alert(1)>"
        self.cli_json("ask", self.dir, "comment", "D1", payload)
        self.cli_json("answer", self.dir, "q1", "--text", payload)
        d4 = dict(next(d for d in fixture()["decisions"] if d["id"] == "D4"), title="Retitled")
        self.apply({"upsert": [d4]}, summary=payload)
        html = self.render(raw=True)
        self.assertNotIn("<img src=x", html)
        thread = Page(html).root.find(data_thread="t1")
        self.assertIn(payload, thread.text())
        row = Page(html).root.find(data_change=True)
        self.assertIn(payload, row.text())

    def test_page_is_self_contained(self):
        html = self.render(raw=True)
        self.assertNotRegex(html, r'(?:src|href)="https?://')
        self.assertNotIn("@import", html)
        self.assertNotIn("<link", html)
        self.assertEqual(Page(html).root.find_all("script", src=True), [])

    def test_render_keeps_no_diagram_cache(self):
        self.render()
        self.assertFalse((self.state_dir(self.dir) / "diagrams").exists())

    def test_help_lists_render(self):
        self.assertRegex(self.cli("--help").stdout, r"(?m)^render\s")
