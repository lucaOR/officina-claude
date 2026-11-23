"""Black-box tests for the record-session-metrics.js hook.

The hook derives both the transcript directory and the metrics directory from
$HOME, so pointing HOME at a temporary directory isolates it completely from
the real ledgers. Fixtures use timestamps far in the past because the hook
records only sessions quiesced for more than 120 seconds.

Plain unittest: there is no pytest on this host.
"""
import csv
import json
import os
import re
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

HOOK = Path(__file__).resolve().parent / "record-session-metrics.js"

# The ttl/break boundary is configurable, so the fixtures that straddle it are
# derived from whatever the hook actually defaults to rather than from a literal
# that merely happens to sit on the right side of it today.
TTL_GAP_MIN = int(
    re.search(r"METRICS_TTL_GAP_MIN \|\| (\d+)", HOOK.read_text()).group(1)
)
# The ledger generation suffix, read from the hook for the same reason. The
# .v3 -> .v4 bump on 2026-08-20 left this suite opening sessions.v3.csv, so
# every HookCase test errored on a missing file while the hook itself was fine.
GEN = re.search(
    r"METRICS_SUFFIX !== undefined \? process\.env\.METRICS_SUFFIX : '([^']+)'",
    HOOK.read_text(),
).group(1)
# Likewise the floor a write must clear to be logged as an event at all: a
# fixture below it exercises nothing, however large the number looks.
BREAK_MIN_CC = int(
    re.search(r"METRICS_BREAK_MIN_CC \|\| (\d+)", HOOK.read_text()).group(1)
)
BIG = BREAK_MIN_CC + 10000
# The two gates that separate `break` from `growth`, likewise read from the hook
# rather than restated, so tuning either one cannot leave these fixtures asserting
# nothing.
GROWTH_READ_RATIO = float(
    re.search(r"METRICS_GROWTH_READ_RATIO \|\| ([\d.]+)", HOOK.read_text()).group(1)
)
GROWTH_MIN_DROP = int(
    re.search(r"METRICS_GROWTH_MIN_DROP \|\| (\d+)", HOOK.read_text()).group(1)
)
# A `break` is a prefix that SHRANK, so any fixture asserting one has to show the
# cached prefix losing ground: the response before it reads PREFIX, the break
# itself reads only SHRUNK. The pair is derived to clear BOTH gates with room to
# spare -- past the ratio dip and past the absolute floor -- so these tests
# discriminate on the kind under test rather than on the shrink gate. A write
# whose cache_read does NOT fall that way is `growth`, not `break`.
SHRUNK = BREAK_MIN_CC
PREFIX = int(SHRUNK / GROWTH_READ_RATIO) + GROWTH_MIN_DROP * 5
# A prefix wide enough that the two gates can be exercised INDEPENDENTLY: at this
# size a dip that only just clears the ratio still falls further than the absolute
# floor, so a fixture can fail one gate while comfortably passing the other. At
# PREFIX the two are too close together to tell apart.
WIDE = int(GROWTH_MIN_DROP / (1 - GROWTH_READ_RATIO)) * 2
T0 = datetime(2026, 1, 1, 10, 0, 0)


def at(minutes):
    """Timestamp `minutes` after the session's first response."""
    return (T0 + timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%S.000Z")


REAL_MODEL = "claude-opus-5"


def assistant(mid, ts, inp, read, create, out, text="ok", model=REAL_MODEL):
    return {
        "type": "assistant",
        "timestamp": ts,
        "message": {
            "id": mid,
            "model": model,
            "content": [{"type": "text", "text": text}],
            "usage": {
                "input_tokens": inp,
                "cache_read_input_tokens": read,
                "cache_creation_input_tokens": create,
                "output_tokens": out,
            },
        },
    }


def synthetic(mid, ts, text="API Error: 500", api_error=True):
    """A placeholder record the harness writes for a non-model event.

    Claude Code mints these for API errors AND for interrupt / cancel / reject
    (src/utils/messages.ts:302-308, all routed through the factory at :388-400),
    stamping `model: '<synthetic>'` and a fresh randomUUID id. The `usage` slot
    is always present and always all-zero, which is exactly why a presence check
    lets it through. Upstream refuses it in three places -- getTokenUsage
    (src/utils/tokens.ts:8-20), getAssistantMessageId (:22-38) and stats.ts:314.

    `api_error=None` writes the flag out as an explicit `false`, which is the
    shape a real non-error placeholder has (measured over 97 of them: 89 carry
    `true`, and the 8 that do not carry `false` explicitly, all of them "No
    response requested."). `api_error=False` omits the key entirely. Both must
    read as "not an error".
    """
    rec = {
        "type": "assistant",
        "timestamp": ts,
        "message": {
            "id": mid,
            "model": "<synthetic>",
            "content": [{"type": "text", "text": text}],
            "usage": {
                "input_tokens": 0,
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0,
                "output_tokens": 0,
            },
        },
    }
    if api_error:
        rec["isApiErrorMessage"] = True
    elif api_error is None:
        rec["isApiErrorMessage"] = False
    return rec


def user_text(ts, text):
    return {
        "type": "user",
        "timestamp": ts,
        "message": {"role": "user", "content": [{"type": "text", "text": text}]},
    }


def user_str(ts, text):
    return {
        "type": "user",
        "timestamp": ts,
        "message": {"role": "user", "content": text},
    }


class HookCase(unittest.TestCase):
    """Runs the hook over a synthetic transcript inside a throwaway HOME."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)

    def run_hook(self, session_id, records, env_extra=None):
        proj_root = self.tmp / "proj"
        proj_root.mkdir(exist_ok=True)
        slug = str(proj_root).replace("/", "-").replace(".", "-")
        tdir = self.tmp / "home" / ".claude" / "projects" / slug
        tdir.mkdir(parents=True, exist_ok=True)
        (tdir / f"{session_id}.jsonl").write_text(
            "\n".join(json.dumps(r) for r in records) + "\n"
        )
        env = dict(
            os.environ,
            HOME=str(self.tmp / "home"),
            CLAUDE_PROJECT_DIR=str(proj_root),
            **(env_extra or {}),
        )
        proc = subprocess.run(
            ["node", str(HOOK)], env=env, capture_output=True, text=True, timeout=60
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.metrics = self.tmp / "home" / ".claude" / "metrics"

    def rows(self, name):
        with open(self.metrics / f"{name}{GEN}.csv", newline="") as fh:
            return list(csv.DictReader(fh))


class TestInitContext(HookCase):
    def test_init_context_is_the_first_response_context(self):
        self.run_hook(
            "11111111-0000-0000-0000-000000000000",
            [
                assistant("m1", "2026-01-01T10:00:00.000Z", 10, 47000, 600, 50),
                assistant("m2", "2026-01-01T10:05:00.000Z", 5, 52000, 900, 40),
            ],
        )
        sessions = self.rows("sessions")
        self.assertEqual(len(sessions), 1)
        # 10 + 47000 + 600 -- the context of the FIRST response, not the peak.
        self.assertEqual(sessions[0]["init_context"], "47610")
        self.assertEqual(sessions[0]["peak_context"], "52905")

        segments = self.rows("segments")
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0]["init_context"], "47610")

    def test_each_segment_records_its_own_floor(self):
        self.run_hook(
            "22222222-0000-0000-0000-000000000000",
            [
                assistant("m1", "2026-01-01T10:00:00.000Z", 10, 120000, 600, 50),
                {
                    "type": "user",
                    "timestamp": "2026-01-01T10:01:00.000Z",
                    "isCompactSummary": True,
                    "message": {"role": "user", "content": "summary text"},
                },
                assistant("m2", "2026-01-01T10:02:00.000Z", 20, 68000, 2000, 30),
            ],
        )
        segments = self.rows("segments")
        self.assertEqual(len(segments), 2)
        self.assertEqual(segments[0]["init_context"], "120610")
        self.assertEqual(segments[1]["init_context"], "70020")
        # The session-level value is segment 0's: how the session OPENED.
        self.assertEqual(self.rows("sessions")[0]["init_context"], "120610")


class TestHandoffSentinel(HookCase):
    def test_sentinel_sets_flag_and_parent(self):
        parent = "aaaaaaaa-1111-2222-3333-444444444444"
        note = (
            f"HANDOFF v1 mode=mid parent={parent}\n"
            "goal: make the floor measurable\n"
            "hypothesis: init_context is the right column\n"
        )
        self.run_hook(
            "33333333-0000-0000-0000-000000000000",
            [
                user_text("2026-01-01T09:59:00.000Z", note),
                assistant("m1", "2026-01-01T10:00:00.000Z", 10, 47000, 600, 50),
            ],
        )
        row = self.rows("sessions")[0]
        self.assertEqual(row["handoff"], "1")
        self.assertEqual(row["parent_session"], parent)

    def test_sentinel_sets_flag_and_parent_bare_string(self):
        # A human pasting a handoff note lands message.content as a plain string,
        # not a list of typed blocks -- that's the branch production actually
        # exercises (record-session-metrics.js:250), and the case above only
        # covers the array-of-blocks branch (:247).
        parent = "bbbbbbbb-1111-2222-3333-444444444444"
        note = (
            f"HANDOFF v1 mode=boundary parent={parent}\n"
            "goal: cover the bare-string content path\n"
        )
        self.run_hook(
            "55555555-0000-0000-0000-000000000000",
            [
                user_str("2026-01-01T09:59:00.000Z", note),
                assistant("m1", "2026-01-01T10:00:00.000Z", 10, 47000, 600, 50),
            ],
        )
        row = self.rows("sessions")[0]
        self.assertEqual(row["handoff"], "1")
        self.assertEqual(row["parent_session"], parent)

    def test_sentinel_is_found_after_the_path_in_a_pointer(self):
        # The note itself is no longer pasted. The pasted line leads with the
        # note's path -- the part whose loss costs content, kept inside the first
        # 80 columns where a wrapped-line mis-copy cannot reach it -- and carries
        # the sentinel in the tail. An anchored ^ would match none of these and
        # score every pointer-seeded session as a cold /clear.
        parent = "cccccccc-1111-2222-3333-444444444444"
        pointer = (
            f"read /home/dev/.claude/handoff/{parent}.md"
            f" \u2014 HANDOFF v1 mode=boundary parent={parent}"
        )
        self.run_hook(
            "77777777-0000-0000-0000-000000000000",
            [
                user_str("2026-01-01T09:59:00.000Z", pointer),
                assistant("m1", "2026-01-01T10:00:00.000Z", 10, 47000, 600, 50),
            ],
        )
        row = self.rows("sessions")[0]
        self.assertEqual(row["handoff"], "1")
        self.assertEqual(row["parent_session"], parent)

    def test_session_without_the_sentinel_is_not_a_handoff(self):
        self.run_hook(
            "44444444-0000-0000-0000-000000000000",
            [
                user_text("2026-01-01T09:59:00.000Z", "just a normal first message"),
                assistant("m1", "2026-01-01T10:00:00.000Z", 10, 47000, 600, 50),
            ],
        )
        row = self.rows("sessions")[0]
        self.assertEqual(row["handoff"], "0")
        self.assertEqual(row["parent_session"], "")


class TestRegistration(unittest.TestCase):
    """A hook nobody registered never runs, and the failure is silent.

    Everything else in this file would still pass for a script the harness never
    invokes, so assert the wiring itself.
    """

    def test_hook_is_registered_as_a_session_end_hook(self):
        settings = json.loads((HOOK.parent / "hooks.json").read_text())
        commands = [
            h.get("command", "")
            for group in settings.get("hooks", {}).get("SessionEnd", [])
            for h in group.get("hooks", [])
        ]
        self.assertTrue(
            any(HOOK.name in c for c in commands),
            f"{HOOK.name} is not registered under SessionEnd: {commands}",
        )


class TestCacheWriteKinds(HookCase):
    """Classification of large cache writes into cold / compact / ttl / break.

    Only writes at or above METRICS_BREAK_MIN_CC (20k) are logged at all, so
    every fixture below uses 30k, and the small-write turns use 600.
    """

    def kinds(self):
        return [(r["seq"], r["kind"], r["gap_min"]) for r in self.rows("breaks")]

    def test_cold_then_break_then_ttl(self):
        self.run_hook(
            "66666666-0000-0000-0000-000000000000",
            [
                # First response of the session: a boot, whatever it costs.
                assistant("m1", at(0), 10, PREFIX, 30000, 50),
                # Well inside the TTL the prefix is still cached, and the read
                # collapses -- so a large write here really is cache thrown away.
                assistant("m2", at(TTL_GAP_MIN // 2), 10, SHRUNK, 30000, 50),
                # Well past it the entry was gone before the request, so nothing
                # was discarded and the rewrite was unavoidable.
                assistant("m3", at(TTL_GAP_MIN * 2), 10, SHRUNK, 30000, 50),
            ],
        )
        self.assertEqual(
            self.kinds(),
            [
                ("0", "cold", ""),
                # gap_min is measured against the PREVIOUS response, not the
                # start of the session -- m3 sits 1.5x the threshold after m2.
                ("1", "break", f"{TTL_GAP_MIN // 2:.1f}"),
                ("2", "ttl", f"{TTL_GAP_MIN * 2 - TTL_GAP_MIN // 2:.1f}"),
            ],
        )

    def test_exactly_the_threshold_counts_as_expiry(self):
        # The comparison is >=, because the threshold is the point at which
        # upstream considers the TTL guaranteed expired for every user.
        self.run_hook(
            "77777777-0000-0000-0000-000000000000",
            [
                assistant("m1", at(0), 10, 0, 600, 50),
                assistant("m2", at(TTL_GAP_MIN), 10, 20000, 30000, 50),
            ],
        )
        self.assertEqual(self.kinds(), [("1", "ttl", f"{TTL_GAP_MIN:.1f}")])

    def test_just_under_the_threshold_stays_a_break(self):
        self.run_hook(
            "88888888-0000-0000-0000-000000000000",
            [
                assistant("m1", at(0), 10, PREFIX, 600, 50),
                assistant("m2", at(TTL_GAP_MIN - 1), 10, SHRUNK, 30000, 50),
            ],
        )
        self.assertEqual(self.kinds(), [("1", "break", f"{TTL_GAP_MIN - 1:.1f}")])

    def test_the_threshold_is_read_from_the_environment(self):
        # Forces the boundary somewhere the default could never put it, which is
        # what proves the two tests above discriminate on the threshold rather
        # than on the gap happening to be large or small.
        forced = TTL_GAP_MIN * 4
        self.run_hook(
            "bbbbbbbb-0000-0000-0000-000000000000",
            [
                assistant("m1", at(0), 10, PREFIX, 600, 50),
                # A gap that IS expiry under the default, but not under `forced`.
                assistant("m2", at(TTL_GAP_MIN * 2), 10, SHRUNK, 30000, 50),
                assistant("m3", at(TTL_GAP_MIN * 7), 10, SHRUNK, 30000, 50),
            ],
            env_extra={"METRICS_TTL_GAP_MIN": str(forced)},
        )
        self.assertEqual([k for _, k, _ in self.kinds()], ["break", "ttl"])

    def test_compaction_rebuild_outranks_a_long_gap(self):
        # A post-compaction write is large because of the summary, not because
        # the session idled -- so `compact` must win even when the gap alone
        # would have qualified as expiry.
        self.run_hook(
            "99999999-0000-0000-0000-000000000000",
            [
                assistant("m1", at(0), 10, 0, 600, 50),
                {
                    "type": "user",
                    "timestamp": at(1),
                    "isCompactSummary": True,
                    "message": {"role": "user", "content": "summary text"},
                },
                assistant("m2", at(TTL_GAP_MIN * 3), 10, 20000, 30000, 50),
            ],
        )
        self.assertEqual([k for _, k, _ in self.kinds()], ["compact"])

    def test_only_breaks_feed_the_session_break_aggregates(self):
        # The sessions row's break columns exist to answer "how much was
        # avoidable", so an expiry must not inflate them.
        self.run_hook(
            "aaaaaaaa-0000-0000-0000-000000000000",
            [
                assistant("m1", at(0), 10, PREFIX, 30000, 50),
                assistant("m2", at(TTL_GAP_MIN // 2), 10, SHRUNK, 30000, 50),
                assistant("m3", at(TTL_GAP_MIN * 2), 10, SHRUNK, 40000, 50),
            ],
        )
        row = self.rows("sessions")[0]
        self.assertEqual(row["breaks"], "1")
        self.assertEqual(row["break_cc"], "30000")


class TestSyntheticRecords(HookCase):
    """A `<synthetic>` record is a harness placeholder, not a billed response.

    Its usage slot exists and is all-zero, so a presence check admits it. Letting
    it through corrupts four things at once, one per test below. The marker under
    test is the model id -- NOT the zero usage and NOT isApiErrorMessage -- because
    interrupts carry the same model with no error flag, and because a real response
    may legitimately bill zero cache_creation.
    """

    def test_a_synthetic_is_not_counted_as_a_response(self):
        self.run_hook(
            "cccccccc-0000-0000-0000-000000000000",
            [
                assistant("m1", at(0), 10, 47000, 600, 50),
                synthetic("syn-1", at(1)),
                assistant("m2", at(2), 20, 48000, 700, 60),
            ],
        )
        row = self.rows("sessions")[0]
        self.assertEqual(row["turns"], "2")

    def test_a_synthetic_does_not_poison_the_model_switch_flag(self):
        # prevModel is guarded with `model || prevModel`, which only rejects an
        # EMPTY id -- '<synthetic>' is a non-empty string, so it latches and the
        # next real response reads as a mid-session model switch it never made.
        self.run_hook(
            "dddddddd-0000-0000-0000-000000000000",
            [
                assistant("m1", at(0), 10, 47000, 600, 50),
                synthetic("syn-1", at(1)),
                assistant("m2", at(2), 10, 20000, 30000, 50),
            ],
        )
        brk = self.rows("breaks")
        self.assertEqual(len(brk), 1)
        self.assertEqual(brk[0]["model_changed"], "0")
        self.assertEqual(brk[0]["prev_model"], REAL_MODEL)
        self.assertEqual(self.rows("sessions")[0]["model_switches"], "0")

    def test_a_synthetic_does_not_zero_the_next_ctx_pre(self):
        # ctx_pre is the size of the prefix the write replaced. A synthetic's own
        # context is 0, so flushing it overwrites lastCtx and the following break
        # -- in production the largest ones -- records a prefix of nothing.
        self.run_hook(
            "eeeeeeee-0000-0000-0000-000000000000",
            [
                assistant("m1", at(0), 10, 120000, 600, 50),
                synthetic("syn-1", at(1)),
                assistant("m2", at(2), 10, 20000, 30000, 50),
            ],
        )
        brk = self.rows("breaks")
        self.assertEqual(len(brk), 1)
        self.assertEqual(brk[0]["ctx_pre"], "120610")
        self.assertEqual(brk[0]["seq"], "1")

    def test_a_synthetic_does_not_split_a_response_in_two(self):
        # Sibling records of one response share message.id; a synthetic carries a
        # fresh randomUUID (messages.ts:391). Landing between two siblings it
        # closes the response and the second sibling reopens the same id, so the
        # response's usage is billed twice -- the v3 interleaving bug again, from
        # a different direction.
        self.run_hook(
            "ffffffff-0000-0000-0000-000000000000",
            [
                assistant("m1", at(0), 10, 47000, 600, 50, text="first block"),
                synthetic("syn-1", at(0)),
                assistant("m1", at(0), 10, 47000, 600, 50, text="second block"),
                assistant("m2", at(1), 20, 48000, 700, 60),
            ],
        )
        row = self.rows("sessions")[0]
        self.assertEqual(row["turns"], "2")
        # m1 + m2 counted once each: (10+47000+600+50) + (20+48000+700+60).
        self.assertEqual(row["total_billed"], str(47660 + 48780))

    def test_an_interrupt_synthetic_is_skipped_without_the_error_flag(self):
        # Keying the guard on isApiErrorMessage would pass every test above and
        # still miss every interrupt, which is the commoner event.
        self.run_hook(
            "0a0a0a0a-0000-0000-0000-000000000000",
            [
                assistant("m1", at(0), 10, 120000, 600, 50),
                synthetic(
                    "syn-1",
                    at(1),
                    text="[Request interrupted by user]",
                    api_error=False,
                ),
                assistant("m2", at(2), 10, 20000, 30000, 50),
            ],
        )
        self.assertEqual(self.rows("sessions")[0]["turns"], "2")
        self.assertEqual(self.rows("breaks")[0]["ctx_pre"], "120610")

    def test_a_synthetic_error_labels_the_next_large_write_a_retry(self):
        # A failed request bills nothing and caches nothing, so the re-sent
        # request rewrites the prefix from scratch. That write is not cache the
        # session threw away -- there was never an entry to throw away -- so it
        # must not sit in the avoidable column.
        self.run_hook(
            "1c1c1c1c-0000-0000-0000-000000000000",
            [
                assistant("m1", at(0), 10, 47000, 600, 50),
                synthetic("syn-1", at(1)),
                assistant("m2", at(2), 10, 0, BIG, 50),
            ],
        )
        brk = self.rows("breaks")
        self.assertEqual([(r["seq"], r["kind"]) for r in brk], [("1", "retry")])

    def test_a_non_error_synthetic_leaves_the_next_write_a_break(self):
        # The discriminator for the LABEL is isApiErrorMessage, not the model id
        # the skip keys on: an interrupt is user-caused and the prefix it
        # abandons really was thrown away, so that write stays avoidable.
        # Written as an explicit `false`, which is the shape real ones have.
        self.run_hook(
            "2c2c2c2c-0000-0000-0000-000000000000",
            [
                assistant("m1", at(0), 10, 47000, 600, 50),
                synthetic("syn-1", at(1), text="No response requested.", api_error=None),
                assistant("m2", at(2), 10, 0, BIG, 50),
            ],
        )
        self.assertEqual([r["kind"] for r in self.rows("breaks")], ["break"])

    def test_a_missing_error_flag_also_leaves_the_next_write_a_break(self):
        # Same assertion with the key absent rather than false, because an
        # `o.isApiErrorMessage` truthiness test would pass the case above too.
        self.run_hook(
            "3c3c3c3c-0000-0000-0000-000000000000",
            [
                assistant("m1", at(0), 10, 47000, 600, 50),
                synthetic(
                    "syn-1", at(1), text="[Request interrupted by user]", api_error=False
                ),
                assistant("m2", at(2), 10, 0, BIG, 50),
            ],
        )
        self.assertEqual([r["kind"] for r in self.rows("breaks")], ["break"])

    def test_expiry_outranks_a_retry(self):
        # 81 of 89 observed error placeholders are rate-limit hits, and those are
        # waited out for hours -- by the time the request is re-sent the entry has
        # expired on its own. Expiry is the certain cause at that gap; the error
        # merely happens to be the last record before it.
        self.run_hook(
            "4c4c4c4c-0000-0000-0000-000000000000",
            [
                assistant("m1", at(0), 10, 47000, 600, 50),
                synthetic("syn-1", at(1)),
                assistant("m2", at(TTL_GAP_MIN * 2), 10, 0, BIG, 50),
            ],
        )
        self.assertEqual([r["kind"] for r in self.rows("breaks")], ["ttl"])

    def test_a_retry_label_is_consumed_by_the_response_it_labels(self):
        # One failed request explains ONE rewrite. A second large write later in
        # the session is an ordinary break again, or the flag would launder every
        # subsequent one.
        self.run_hook(
            "5c5c5c5c-0000-0000-0000-000000000000",
            [
                assistant("m1", at(0), 10, 47000, 600, 50),
                synthetic("syn-1", at(1)),
                assistant("m2", at(2), 10, 0, BIG, 50),
                # The retry's rewrite is read back on the following turn, which is
                # what gives m3 a live prefix to lose. Without it m3 would only be
                # growing a prefix that started at nothing, which is not a break.
                assistant("m2b", at(3), 10, PREFIX, 600, 50),
                assistant("m3", at(4), 10, SHRUNK, BIG, 50),
            ],
        )
        self.assertEqual(
            [r["kind"] for r in self.rows("breaks")], ["retry", "break"]
        )

    def test_an_error_between_siblings_labels_the_response_after_it(self):
        # The failure arrives while m1 is still open, so m1 is flushed AFTER the
        # arming record is read even though it ran BEFORE the failure. A flag
        # merely "cleared by the next flush" is therefore consumed by m1 and the
        # retry lands one response too early -- m1 laundered, m2 still avoidable.
        self.run_hook(
            "7c7c7c7c-0000-0000-0000-000000000000",
            [
                # Keeps m1 off seq 0, where `cold` would outrank everything, and
                # gives m1 a prefix to lose so it is a break rather than growth.
                assistant("m0", at(0), 10, PREFIX, 600, 50),
                assistant("m1", at(1), 10, SHRUNK, BIG, 50, text="first block"),
                synthetic("syn-1", at(1)),
                assistant("m1", at(1), 10, SHRUNK, BIG, 50, text="second block"),
                assistant("m2", at(2), 10, SHRUNK, BIG, 50),
            ],
        )
        self.assertEqual(
            [(r["seq"], r["kind"]) for r in self.rows("breaks")],
            [("1", "break"), ("2", "retry")],
        )

    def test_retries_do_not_feed_the_session_break_aggregates(self):
        # Same contract ttl has: the sessions row's break columns answer "how
        # much was avoidable", so an unavoidable rewrite must not inflate them.
        self.run_hook(
            "6c6c6c6c-0000-0000-0000-000000000000",
            [
                assistant("m1", at(0), 10, 0, BIG, 50),
                synthetic("syn-1", at(1)),
                assistant("m2", at(2), 10, 0, BIG + 5000, 50),
            ],
        )
        row = self.rows("sessions")[0]
        self.assertEqual(row["breaks"], "0")
        self.assertEqual(row["break_cc"], "0")

    def test_a_real_response_billing_zero_cache_creation_is_still_counted(self):
        # Proves the guard discriminates on the model id rather than on an
        # all-zero usage slot: a genuine response can bill nothing new and must
        # still be a response.
        self.run_hook(
            "0b0b0b0b-0000-0000-0000-000000000000",
            [
                assistant("m1", at(0), 10, 47000, 600, 50),
                assistant("m2", at(1), 0, 0, 0, 0),
            ],
        )
        self.assertEqual(self.rows("sessions")[0]["turns"], "2")


class TestPrefixGrowth(HookCase):
    """`growth` -- a large write whose cached prefix did not shrink.

    Upstream never decides a break from cache_creation; it asks whether the
    cached prefix got smaller (promptCacheBreakDetection.ts:485-489). A large
    write with an intact cache_read is new content entering the prefix, not
    cache thrown away, so it belongs with the unavoidable kinds.
    """

    def kinds(self):
        return [r["kind"] for r in self.rows("breaks")]

    def test_a_large_write_with_an_intact_prefix_is_growth(self):
        # The head still hit at full strength -- the write is the cost of
        # ingesting something new, which no amount of session hygiene avoids.
        self.run_hook(
            "d1d1d1d1-0000-0000-0000-000000000000",
            [
                assistant("m1", at(0), 10, PREFIX, 600, 50),
                assistant("m2", at(1), 10, PREFIX, BIG, 50),
            ],
        )
        self.assertEqual(self.kinds(), ["growth"])

    def test_a_drop_past_both_gates_is_a_break(self):
        # The positive control for the three tests around it: same shape, but
        # the read genuinely collapses, so the prefix really was discarded.
        self.run_hook(
            "d2d2d2d2-0000-0000-0000-000000000000",
            [
                assistant("m1", at(0), 10, PREFIX, 600, 50),
                assistant("m2", at(1), 10, SHRUNK, BIG, 50),
            ],
        )
        self.assertEqual(self.kinds(), ["break"])

    def test_a_dip_short_of_the_ratio_is_still_growth(self):
        # One token above the ratio line, while the absolute drop clears the
        # floor twice over. Only the ratio gate can save this row, so dropping
        # that gate turns it into a break.
        self.run_hook(
            "d3d3d3d3-0000-0000-0000-000000000000",
            [
                assistant("m1", at(0), 10, WIDE, 600, 50),
                assistant("m2", at(1), 10, int(WIDE * GROWTH_READ_RATIO) + 1, BIG, 50),
            ],
        )
        self.assertEqual(self.kinds(), ["growth"])

    def test_a_drop_short_of_the_floor_is_still_growth(self):
        # The mirror case: the read all but vanishes in relative terms, but the
        # prefix was so small that the absolute loss stays under the floor.
        # Only the floor can save this row, so dropping it turns it into a break.
        self.run_hook(
            "d4d4d4d4-0000-0000-0000-000000000000",
            [
                assistant("m1", at(0), 10, GROWTH_MIN_DROP, 600, 50),
                assistant("m2", at(1), 10, 1, BIG, 50),
            ],
        )
        self.assertEqual(self.kinds(), ["growth"])

    def test_the_shrink_floor_is_read_from_the_environment(self):
        # Forces the floor somewhere the default could never put it, which is
        # what proves the tests above discriminate on the gate rather than on
        # the drop happening to be large or small.
        self.run_hook(
            "d5d5d5d5-0000-0000-0000-000000000000",
            [
                assistant("m1", at(0), 10, PREFIX, 600, 50),
                # A collapse that IS a break under the default floor.
                assistant("m2", at(1), 10, SHRUNK, BIG, 50),
            ],
            env_extra={"METRICS_GROWTH_MIN_DROP": str(PREFIX * 10)},
        )
        self.assertEqual(self.kinds(), ["growth"])

    def test_the_prefix_baseline_tracks_responses_too_small_to_be_logged(self):
        # m2 is an ordinary small write, below the logging floor, but it still
        # moves the resident prefix. If the baseline only advanced on logged
        # rows, m3 would be compared against m1's read -- or against nothing at
        # all -- and a genuine collapse would be filed as growth.
        self.run_hook(
            "d6d6d6d6-0000-0000-0000-000000000000",
            [
                assistant("m1", at(0), 10, SHRUNK, 600, 50),
                assistant("m2", at(1), 10, PREFIX, 600, 50),
                assistant("m3", at(2), 10, SHRUNK, BIG, 50),
            ],
        )
        self.assertEqual(self.kinds(), ["break"])

    def test_expiry_outranks_growth(self):
        # Both labels say "unavoidable", but `ttl` names a cause and `growth`
        # only reports the absence of a shrink, so the named cause wins.
        self.run_hook(
            "d7d7d7d7-0000-0000-0000-000000000000",
            [
                assistant("m1", at(0), 10, PREFIX, 600, 50),
                assistant("m2", at(TTL_GAP_MIN), 10, PREFIX, BIG, 50),
            ],
        )
        self.assertEqual(self.kinds(), ["ttl"])

    def test_a_retry_outranks_growth(self):
        # Same precedence argument as expiry: the failed request is the reason
        # this write exists, which is more informative than "nothing shrank".
        self.run_hook(
            "d8d8d8d8-0000-0000-0000-000000000000",
            [
                assistant("m1", at(0), 10, PREFIX, 600, 50),
                synthetic("syn-1", at(1)),
                assistant("m2", at(2), 10, PREFIX, BIG, 50),
            ],
        )
        self.assertEqual(self.kinds(), ["retry"])

    def test_growth_does_not_feed_the_session_break_aggregates(self):
        # The same contract ttl and retry have: the sessions row's break columns
        # answer "how much was avoidable", so an intact prefix must not inflate
        # them however large the write was.
        self.run_hook(
            "d9d9d9d9-0000-0000-0000-000000000000",
            [
                assistant("m1", at(0), 10, PREFIX, 600, 50),
                assistant("m2", at(1), 10, PREFIX, BIG, 50),
            ],
        )
        row = self.rows("sessions")[0]
        self.assertEqual(row["breaks"], "0")
        self.assertEqual(row["break_cc"], "0")


if __name__ == "__main__":
    unittest.main()
