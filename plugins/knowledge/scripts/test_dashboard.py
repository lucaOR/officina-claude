import io
import json
import unittest
import dashboard


class _Response:
    def __init__(self, status_code, data):
        self.status_code = status_code
        self.data = data

    def get_json(self):
        return json.loads(self.data)


class _TestClient:
    """Minimal stdlib WSGI test client: enough of Flask's test_client() surface
    (.get -> status_code/data/get_json) for these tests, nothing more."""

    def __init__(self, app):
        self.app = app

    def get(self, path):
        path, _, query = path.partition("?")
        environ = {
            "REQUEST_METHOD": "GET",
            "PATH_INFO": path,
            "QUERY_STRING": query,
            "SERVER_NAME": "testserver",
            "SERVER_PORT": "80",
            "wsgi.input": io.BytesIO(b""),
            "wsgi.errors": io.StringIO(),
            "wsgi.version": (1, 0),
            "wsgi.multithread": False,
            "wsgi.multiprocess": False,
            "wsgi.run_once": False,
            "wsgi.url_scheme": "http",
        }
        captured = {}

        def start_response(status, headers):
            captured["status_code"] = int(status.split(" ", 1)[0])

        body = b"".join(self.app(environ, start_response))
        return _Response(captured["status_code"], body)


class TestDashboard(unittest.TestCase):
    def setUp(self):
        self.client = _TestClient(dashboard.create_app())

    def test_index_returns_html_with_canvas(self):
        resp = self.client.get("/")
        self.assertEqual(resp.status_code, 200)
        self.assertIn(b"<canvas", resp.data)

    def test_data_json_has_expected_keys(self):
        resp = self.client.get("/data.json")
        self.assertEqual(resp.status_code, 200)
        payload = resp.get_json()
        for key in ("per_rule", "dead", "violated", "noisy", "top", "by_day", "jit_by_day",
                    "totals", "most_delivered", "most_cited", "resident", "retire"):
            self.assertIn(key, payload)

    def test_page_shows_the_five_sections(self):
        page = self.client.get("/").data
        for token in (b'id="jitTable"', b'id="failChart"', b'id="failTable"',
                      b'id="citedTable"', b'id="residentTable"', b'id="retireTable"'):
            self.assertIn(token, page)
        # jitChart was dropped deliberately: with jit_delivered mostly tied across rules,
        # a bar chart added scroll length without adding information over the table.
        # dayChart is the honest activity-over-time chart, re-added on top of failing_runs +
        # zero-filled by_day (report.py) — topChart/violChart/noisy are unrelated legacy ids.
        for token in (b'id="jitChart"', b'id="topChart"', b'id="violChart"', b'id="noisy"'):
            self.assertNotIn(token, page)

    def test_page_marks_retired_fqids_with_a_strikethrough_style(self):
        page = self.client.get("/").data
        self.assertIn(b".retired{", page)
        self.assertIn(b"in_registry", page)
        self.assertIn(b"no longer exists in the current rule registry", page)

    def test_page_marks_sweep_only_fqids_with_a_strikethrough_style(self):
        page = self.client.get("/").data
        self.assertIn(b".sweep-only{", page)
        self.assertIn(b"r.sweep_only", page)
        self.assertIn(b"only runs during a review sweep, never at edit time", page)

    def test_page_describes_the_purpose_of_each_section(self):
        page = self.client.get("/").data
        for token in (b"auto-delivered into context", b"actually fired as a violation",
                      b"the strongest signal a rule changed a decision", b"candidate to reconsider keeping resident",
                      b"never caught a real violation, and were never cited"):
            self.assertIn(token, page)

    def test_page_shows_activity_over_time_chart(self):
        page = self.client.get("/").data
        self.assertIn(b'id="dayChart"', page)
        self.assertIn(b"failing run", page)   # caveat names the honest framing, not raw fail rows
        self.assertIn(b"zero-filled", page)

    def test_page_shows_unique_rules_used_per_day_chart(self):
        page = self.client.get("/").data
        self.assertIn(b'id="ruleUsageChart"', page)
        self.assertIn(b"jit_by_day", page)
        self.assertIn(b"resident set is a registry attribute", page)

    def test_page_has_tabs_for_the_five_sections(self):
        page = self.client.get("/").data
        self.assertIn(b'class="tabs"', page)
        for tab in (b'data-tab="delivery"', b'data-tab="failures"', b'data-tab="cited"',
                    b'data-tab="resident"', b'data-tab="retire"'):
            self.assertIn(tab, page)

    def test_tables_are_sortable_and_filterable(self):
        page = self.client.get("/").data
        self.assertIn(b"function sortTable", page)
        self.assertIn(b"function filterTable", page)
        self.assertIn(b"filter fqid", page)

    def test_violation_rate_is_formatted_as_a_percentage(self):
        page = self.client.get("/").data
        self.assertIn(b"violation_rate:pct", page)

    def test_static_chart_js_served(self):
        resp = self.client.get("/static/chart.umd.min.js")
        self.assertEqual(resp.status_code, 200)

    def test_data_json_accepts_service_filter(self):
        resp = self.client.get("/data.json?service=catalog-api")
        self.assertEqual(resp.status_code, 200)
        self.assertIn("totals", resp.get_json())

    def test_data_json_since_narrows_the_window(self):
        wide = self.client.get("/data.json?since=2000-01-01").get_json()
        narrow = self.client.get("/data.json?since=2999-01-01").get_json()
        self.assertGreaterEqual(wide["totals"]["runs"], narrow["totals"]["runs"])
        self.assertEqual(narrow["totals"]["runs"], 0)      # future cutoff -> empty window
        self.assertEqual(narrow["by_day"], [])

    def test_data_json_bad_since_is_400_not_500(self):
        resp = self.client.get("/data.json?since=last-tuesday")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("bad since", resp.get_json()["error"])

    def test_data_json_empty_since_keeps_full_window(self):
        full = self.client.get("/data.json").get_json()
        blank = self.client.get("/data.json?since=").get_json()
        self.assertEqual(blank["totals"], full["totals"])

    def test_page_sends_since_and_days(self):
        page = self.client.get("/").data
        for token in (b'id="since"', b'id="days"', b"q.set(key,v)"):
            self.assertIn(token, page)

    def test_page_shows_never_fired_as_a_count_not_a_table(self):
        page = self.client.get("/").data
        self.assertNotIn(b'id="dead"', page)          # the table is gone
        self.assertIn(b"never fired", page)           # the count card remains
        self.assertIn(b"unreachable_glob", page)      # and points at the static check


if __name__ == "__main__":
    unittest.main()
