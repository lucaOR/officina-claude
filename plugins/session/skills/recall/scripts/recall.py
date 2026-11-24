#!/usr/bin/env python3
"""/session:recall: archive a project's transcripts and search them along the handoff chain.

Subcommands:
  whoami                 print this session's id and transcript directory, for the subagent
  search [--stdin] [WORDING...]  search the chain (tier 1), then the project (tier 2), --all: everything
  show SESSION POS       print the archived exchange around one hit, tool results in full
  forget SESSION|this    delete a session from the archive and skip it from now on
  ingest --project DIR   archive and index one transcript directory (the detached startup job)
  rebuild                rebuild the index from the archive
  hook                   SessionStart hook: record the opt-out switch, spawn ingest, return

Everything lives under ~/.claude/recall (RECALL_HOME overrides it), outside every repository,
with mode 0700 for directories and 0600 for files:
  archive/<project>/<session>.jsonl.gz        conversation entries only (transcript.keep)
  archive/<project>/<session>/subagents/...    the session's subagent transcripts
  notes/<session>.md | .skip                   the handoff note copy, or "never archive it"
  index.sqlite                                 session table and the FTS5 row table
  state.json                                   what was ingested, and which backfills finished
  optout.json, deny.json                       opted-out projects and forgotten sessions

A session's rows get consecutive rowids, recorded in its session row, so replacing a grown
transcript deletes a rowid range instead of scanning the whole FTS table.
"""
import argparse
import bisect
import contextlib
import fcntl
import gzip
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[2] / "lib"))
import transcript as tr  # noqa: E402
from lineage import SESSION_ID_RE, find_transcript, projects_root, search_dirs  # noqa: E402

RETENTION_DAYS = 180
MAX_HITS = 40
SNIPPET = 300
WIDEN_BELOW = 5          # tier 2 is searched when tier 1 has fewer distinct matching rows
LOCK_WAIT = 5.0          # seconds the bounded ingest in search waits for the lock
NOTE_WEIGHT = 2.0        # bm25 is negative, lower ranks first, so a note's score is doubled
SHOW_CONTEXT = 3
SHOW_CAP = 20000
TOKEN = re.compile(r"\w+")
GOAL = re.compile(r"^goal:\s*(.+)$", re.M)

SESSION_DDL = """CREATE TABLE IF NOT EXISTS session(
    id TEXT PRIMARY KEY, project TEXT NOT NULL, started TEXT, ended TEXT, parent TEXT,
    title TEXT, note TEXT, goal TEXT, excluded INTEGER NOT NULL DEFAULT 0,
    row_lo INTEGER, row_hi INTEGER)"""


# --- storage -------------------------------------------------------------------------------

def store() -> Path:
    return Path(os.environ.get("RECALL_HOME") or Path.home() / ".claude" / "recall")


def ensure_store() -> Path:
    s = store()
    s.mkdir(parents=True, exist_ok=True)
    os.chmod(s, 0o700)
    return s


def env_int(name, default):
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def disabled() -> bool:
    return os.environ.get("RECALL_DISABLE") == "1"


def load_json(name, default):
    try:
        return json.loads((store() / name).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def save_json(name, value):
    path = ensure_store() / name
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(value), encoding="utf-8")
    os.replace(tmp, path)


def load_state():
    state = load_json("state.json", {})
    state.setdefault("sessions", {})
    state.setdefault("projects", {})
    return state


def optouts() -> set:
    return set(load_json("optout.json", []))


def record_optout(slug, on=True):
    current = optouts()
    if (slug in current) == on:
        return
    current.add(slug) if on else current.discard(slug)
    save_json("optout.json", sorted(current))


def denied() -> set:
    return set(load_json("deny.json", []))


def handoff_note(sid) -> Path:
    return Path.home() / ".claude" / "handoff" / f"{sid}.md"


def notes_dir() -> Path:
    d = ensure_store() / "notes"
    d.mkdir(exist_ok=True)
    return d


def mark_skip(sid, always=False, parent=None, slug=None):
    """Tell the sweep a note will never be archived, so it may delete it once read.

    The marker also records the session's parent and project, so a rebuild can recreate the
    excluded row that keeps the chain walk passing through the session.
    """
    if always or handoff_note(sid).is_file():
        marker = notes_dir() / f"{sid}.skip"
        if parent or slug or not marker.exists():
            marker.write_text(json.dumps({"parent": parent, "project": slug}), encoding="utf-8")


def read_marker(sid) -> dict:
    try:
        data = json.loads((store() / "notes" / f"{sid}.skip").read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def project_dir(value) -> Path:
    return Path(value) if os.sep in str(value) else projects_root() / value


@contextlib.contextmanager
def ingest_lock(wait):
    """One ingest at a time. Yields False when the lock stays held for `wait` seconds."""
    fh = open(ensure_store() / "ingest.lock", "a")
    deadline = time.monotonic() + wait
    try:
        while True:
            try:
                fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    yield False
                    return
                time.sleep(0.1)
        yield True
    finally:
        fh.close()


def write_gz(path: Path, entries):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with gzip.open(tmp, "wb", compresslevel=6) as fh:
        for e in entries:
            fh.write(json.dumps(e, ensure_ascii=False).encode("utf-8") + b"\n")
    os.replace(tmp, path)


# --- index ---------------------------------------------------------------------------------

def fts5_available() -> bool:
    if os.environ.get("RECALL_NO_FTS5") == "1":      # lets the tests exercise the fallback
        return False
    try:
        sqlite3.connect(":memory:").execute("CREATE VIRTUAL TABLE t USING fts5(x)")
        return True
    except sqlite3.Error:
        return False


class Index:
    """index.sqlite. Raises sqlite3.DatabaseError when the file is not a readable index."""

    def __init__(self):
        self.db = sqlite3.connect(ensure_store() / "index.sqlite", timeout=30)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT)")
        row = self.db.execute("SELECT v FROM kv WHERE k = 'fts'").fetchone()
        if row is None:
            self.fts = fts5_available()
            self.db.execute("INSERT INTO kv VALUES ('fts', ?)", ("1" if self.fts else "0",))
        else:
            self.fts = row[0] == "1"
        self.db.execute(SESSION_DDL)
        self.db.execute("CREATE INDEX IF NOT EXISTS session_project ON session(project)")
        if self.fts:
            self.db.execute(
                "CREATE VIRTUAL TABLE IF NOT EXISTS block USING fts5(body, sid UNINDEXED, "
                "role UNINDEXED, pos UNINDEXED, ts UNINDEXED, "
                "tokenize = 'porter unicode61 remove_diacritics 2')")
        else:
            self.db.execute("CREATE TABLE IF NOT EXISTS block(body TEXT, sid TEXT, role TEXT, "
                            "pos TEXT, ts TEXT)")
            self.db.execute("CREATE INDEX IF NOT EXISTS block_sid ON block(sid)")
        self.db.commit()

    def drop_rows(self, sid):
        r = self.db.execute("SELECT row_lo, row_hi FROM session WHERE id = ?", (sid,)).fetchone()
        if r and r[0] is not None:
            self.db.execute("DELETE FROM block WHERE rowid BETWEEN ? AND ?", r)

    def put(self, sid, slug, meta, rows, note=None, goal=None, excluded=False):
        self.drop_rows(sid)
        top = self.db.execute("SELECT rowid FROM block ORDER BY rowid DESC LIMIT 1").fetchone()
        lo = (top[0] if top else 0) + 1
        self.db.executemany(
            "INSERT INTO block(rowid, body, sid, role, pos, ts) VALUES (?, ?, ?, ?, ?, ?)",
            [(lo + i, body, sid, role, pos, ts) for i, (role, pos, ts, body) in enumerate(rows)])
        span = (lo, lo + len(rows) - 1) if rows else (None, None)
        self.db.execute(
            "INSERT OR REPLACE INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (sid, slug, meta.get("started"), meta.get("ended"), meta.get("parent"),
             None if excluded else meta.get("title"), str(note) if note else None, goal,
             1 if excluded else 0, *span))

    def parent(self, sid):
        r = self.db.execute("SELECT parent FROM session WHERE id = ?", (sid,)).fetchone()
        return r[0] if r else None


def drop_session(ix, sid, slug=None, exclude=False, parent=None):
    """Remove a session from the index, the archive and the note copies.

    With exclude, an excluded row (id, project and parent only) and a .skip marker stay, so the
    chain walk passes through the session although its content is gone.
    """
    r = ix.db.execute("SELECT project, parent FROM session WHERE id = ?", (sid,)).fetchone()
    slug = slug or (r[0] if r else None)
    parent = parent or (r[1] if r else None)
    ix.drop_rows(sid)
    ix.db.execute("DELETE FROM session WHERE id = ?", (sid,))
    # With no index row the project is unknown, so every project's archive is searched for it.
    adirs = [store() / "archive" / slug] if slug else sorted((store() / "archive").glob("*"))
    for adir in adirs:
        (adir / f"{sid}.jsonl.gz").unlink(missing_ok=True)
        shutil.rmtree(adir / sid, ignore_errors=True)
    (store() / "notes" / f"{sid}.md").unlink(missing_ok=True)
    if exclude:
        f = find_transcript(sid)
        if f and not (parent and slug):
            parent = parent or tr.meta(tr.keep(tr.read_entries(f)))["parent"]
            slug = slug or f.parent.name
        marker = read_marker(sid)
        parent, slug = parent or marker.get("parent"), slug or marker.get("project")
        if slug:
            ix.put(sid, slug, {"parent": parent}, [], excluded=True)
        mark_skip(sid, always=True, parent=parent, slug=slug)


def copy_note(sid):
    """Copy the handoff note into the archive so the sweep never sees a half-written copy."""
    dest = notes_dir() / f"{sid}.md"
    tmp = dest.with_name(dest.name + ".tmp")
    shutil.copyfile(handoff_note(sid), tmp)
    os.replace(tmp, dest)


def note_rows(sid, meta):
    """The archived note copy as a row, and its goal line."""
    copy = store() / "notes" / f"{sid}.md"
    try:
        text = copy.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None, [], None
    m = GOAL.search(text)
    return copy, [("note", "note", meta.get("ended") or "", text)], (m.group(1)[:100] if m else None)


# --- ingest --------------------------------------------------------------------------------

def subagent_files(f: Path):
    return sorted((f.parent / f.stem / "subagents").glob("*.jsonl"))


def signature(f: Path, sid):
    parts = []
    for p in (f, *subagent_files(f), handoff_note(sid)):
        try:
            st = p.stat()
            parts.append([p.name, st.st_size, st.st_mtime_ns])
        except OSError:
            pass
    return parts


def recall_subagent(path: Path, kept) -> bool:
    """A transcript of recall's own subagent, whose excerpts would echo back as hits."""
    try:
        agent = json.loads(path.with_suffix(".meta.json").read_text(encoding="utf-8"))
        if str(agent.get("agentType", "")).split(":")[-1] == "recall":
            return True
    except (OSError, ValueError, AttributeError):
        pass
    first = next((e for e in kept if e.get("type") == "user"), None)
    return bool(first) and tr.text_of(tr.content_of(first)).startswith("RECALL v1")


LEFT_OUT = "[left out: note of a skipped session]"


def note_path_re():
    """A path to a handoff note, or to recall's archived copy of one, with the session id."""
    where = [r"\.claude/handoff", r"\.claude/recall/notes", re.escape(str(store() / "notes"))]
    return re.compile(r"(?:" + "|".join(where) + r")/([0-9a-fA-F-]{8,})\.md")


def skipped_session(sid) -> bool:
    """Whether a session is excluded, decided by its marker, the deny list or its own transcript,
    so the answer does not depend on whether its own ingest has run yet."""
    if (store() / "notes" / f"{sid}.skip").is_file() or sid in denied():
        return True
    f = find_transcript(sid)
    return bool(f) and tr.meta(tr.keep(tr.read_entries(f)))["skip"]


def leave_out_skipped_notes(kept):
    """Replace the result of a tool call that read a skipped session's handoff note.

    The note text would otherwise land in the reader's tool result, which is archived and
    indexed. The tool call itself stays.
    """
    pattern, verdict, hidden = note_path_re(), {}, set()
    for e in kept:
        content = tr.content_of(e)
        for b in content if e.get("type") == "assistant" and isinstance(content, list) else ():
            if not isinstance(b, dict) or b.get("type") != "tool_use" \
                    or b.get("name") not in ("Read", "Bash"):
                continue
            args = b.get("input") if isinstance(b.get("input"), dict) else {}
            for sid in pattern.findall(str(args.get("file_path") or args.get("command") or "")):
                if sid not in verdict:
                    verdict[sid] = SESSION_ID_RE.match(sid) is not None and skipped_session(sid)
                if verdict[sid]:
                    hidden.add(b.get("id"))
    if not hidden:
        return kept
    for e in kept:
        content = tr.content_of(e)
        for b in content if e.get("type") == "user" and isinstance(content, list) else ():
            if isinstance(b, dict) and b.get("type") == "tool_result" \
                    and b.get("tool_use_id") in hidden:
                b["content"] = LEFT_OUT
    return kept


def ingest_session(ix, state, f: Path):
    """Archive and index one transcript when it is new or changed since the last run."""
    sid, slug = f.stem, f.parent.name
    if not SESSION_ID_RE.match(sid):
        return
    sig = signature(f, sid)
    if state["sessions"].get(sid) == sig:
        return
    if sid in denied():
        drop_session(ix, sid, slug, exclude=True,
                     parent=tr.meta(tr.keep(tr.read_entries(f)))["parent"])
        state["sessions"][sid] = sig
        return
    if slug in optouts():
        drop_session(ix, sid)
        mark_skip(sid)
        state["sessions"][sid] = sig
        return
    kept = tr.keep(tr.read_entries(f))
    meta = tr.meta(kept)
    if meta["skip"]:
        drop_session(ix, sid, slug, exclude=True, parent=meta["parent"])
        state["sessions"][sid] = sig
        return
    kept = leave_out_skipped_notes(kept)
    adir = store() / "archive" / slug
    write_gz(adir / f"{sid}.jsonl.gz", kept)
    rows = tr.rows(kept)
    shutil.rmtree(adir / sid, ignore_errors=True)
    for sf in subagent_files(f):
        skept = leave_out_skipped_notes(tr.keep(tr.read_entries(sf)))
        if recall_subagent(sf, skept):
            continue
        write_gz(adir / sid / "subagents" / f"{sf.stem}.jsonl.gz", skept)
        rows += tr.rows(skept, subagent=sf.stem)
    if handoff_note(sid).is_file():
        copy_note(sid)
    copy, extra, goal = note_rows(sid, meta)
    ix.put(sid, slug, meta, rows + extra, copy, goal)
    state["sessions"][sid] = sig


def ingest_project(ix, state, pdir: Path):
    slug = pdir.name
    if slug in optouts():
        for (sid,) in ix.db.execute("SELECT id FROM session WHERE project = ?", (slug,)).fetchall():
            drop_session(ix, sid, slug)
        shutil.rmtree(store() / "archive" / slug, ignore_errors=True)
        for f in pdir.glob("*.jsonl"):
            mark_skip(f.stem)
            state["sessions"].pop(f.stem, None)     # re-enabling the project ingests it again
        ix.db.commit()
        return
    state["projects"].setdefault(slug, {})["retention"] = env_int("RECALL_RETENTION_DAYS", RETENTION_DAYS)
    for f in sorted(pdir.glob("*.jsonl")):
        try:
            ingest_session(ix, state, f)
        except Exception:
            ix.db.rollback()                         # one bad file never stops the rest
            continue
        ix.db.commit()
    state["projects"].setdefault(slug, {})["done"] = True


def expire(ix, state):
    """Drop sessions past their own project's retention: the value that project's last ingest
    recorded, 180 days when it never recorded one, and never when that value is 0 or below."""
    now = datetime.now(timezone.utc)
    for slug, in ix.db.execute("SELECT DISTINCT project FROM session").fetchall():
        days = state["projects"].get(slug, {}).get("retention", RETENTION_DAYS)
        if not isinstance(days, int) or days <= 0:
            continue
        cutoff = (now - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S")
        for sid, in ix.db.execute(
                "SELECT id FROM session WHERE project = ? AND ended < ?", (slug, cutoff)).fetchall():
            drop_session(ix, sid, slug)
    ix.db.commit()


def refresh_chain(ix, state, session, pdir: Path, depth):
    """The bounded ingest: this session and its chain, so a parent that ended minutes ago is in."""
    sid, seen = session, set()
    for _ in range(depth + 1):
        if not sid or sid in seen:
            break
        seen.add(sid)
        f = pdir / f"{sid}.jsonl"
        f = f if f.is_file() else find_transcript(sid)
        if f:
            try:
                ingest_session(ix, state, f)
                ix.db.commit()
            except Exception:
                ix.db.rollback()
        sid = ix.parent(sid)


# --- search --------------------------------------------------------------------------------

def chain(ix, session, depth):
    out, sid = [], session
    while sid and len(out) <= depth and sid not in out:
        out.append(sid)
        sid = ix.parent(sid)
    return out


def build_tiers(ix, session, slug, depth):
    links = chain(ix, session, depth)
    ix.db.execute("DROP TABLE IF EXISTS temp.tier")
    ix.db.execute("CREATE TEMP TABLE tier(sid TEXT PRIMARY KEY, tier INTEGER, back INTEGER)")
    ix.db.executemany("INSERT INTO tier VALUES (?, 1, ?)", [(s, i) for i, s in enumerate(links)])
    marks = ",".join("?" * len(links))
    projects = {slug} | {p for (p,) in ix.db.execute(
        f"SELECT DISTINCT project FROM session WHERE id IN ({marks})", links)}
    pmarks = ",".join("?" * len(projects))
    ix.db.execute(f"INSERT OR IGNORE INTO tier SELECT id, 2, NULL FROM session "
                  f"WHERE excluded = 0 AND project IN ({pmarks})", sorted(projects))
    ix.db.execute("INSERT OR IGNORE INTO tier SELECT id, 3, NULL FROM session WHERE excluded = 0")
    # An opted-out project is hidden at query time, because its purge may not have run yet.
    out = sorted(optouts())
    if out:
        ix.db.execute("DELETE FROM tier WHERE sid IN (SELECT id FROM session WHERE project IN "
                      f"({','.join('?' * len(out))}))", out)


def match_clause(ix, wordings):
    """The WHERE clause and parameters: tokens of one wording all match, wordings are ORed."""
    groups = [TOKEN.findall(w) for w in wordings]
    groups = [g for g in groups if g]
    if ix.fts:
        expr = " OR ".join("(" + " ".join(f'"{t}"' for t in g) + ")" for g in groups)
        return "block MATCH ?", [expr], groups
    clause = " OR ".join("(" + " AND ".join("block.body LIKE ? ESCAPE '\\'" for _ in g) + ")"
                         for g in groups)
    params = ["%" + t.replace("_", "\\_") + "%" for g in groups for t in g]
    return f"({clause})", params, groups


def excerpt(body, groups):
    """The fallback's snippet: text around the first matching token."""
    low = body.lower()
    at = min((i for i in (low.find(t.lower()) for g in groups for t in g) if i >= 0), default=0)
    start = max(0, at - SNIPPET // 3)
    return ("…" if start else "") + body[start:start + SNIPPET]


def label(tier, back, project):
    if tier == 1:
        return "T1 this session" if back == 0 else f"T1 {back} back"
    return "T2 project" if tier == 2 else f"T3 {project}"


def run_search(ix, wordings, session, slug, depth, everything):
    wordings = [w for w in wordings if TOKEN.search(w)]   # `?!` has nothing to match
    if not wordings:
        return ["note: the query has no searchable words"]
    where, params, groups = match_clause(ix, wordings)
    build_tiers(ix, session, slug, depth)
    counts = dict(ix.db.execute(
        f"SELECT tier.tier, count(*) FROM block JOIN tier ON tier.sid = block.sid "
        f"WHERE {where} GROUP BY tier.tier", params).fetchall())
    top = 3 if everything else (1 if counts.get(1, 0) >= WIDEN_BELOW else 2)
    if ix.fts:
        text, score = "snippet(block, 0, '[', ']', '…', 40)", \
            f"bm25(block) * (CASE block.role WHEN 'note' THEN {NOTE_WEIGHT} ELSE 1.0 END)"
    else:
        text, score = "block.body", "0"
    hits = ix.db.execute(
        f"SELECT block.sid, block.role, block.pos, block.ts, {text}, tier.tier, tier.back, "
        f"session.project, session.goal, {score} AS score "
        f"FROM block JOIN tier ON tier.sid = block.sid JOIN session ON session.id = block.sid "
        f"WHERE {where} AND tier.tier <= ? ORDER BY tier.tier, score, block.ts DESC LIMIT ?",
        [*params, top, MAX_HITS]).fetchall()
    total = sum(n for t, n in counts.items() if t <= top)
    shown = " | ".join(f'"{w}"' for w in wordings)
    if not total:
        return [f"recall: no hits for {shown} in tiers 1-{top}"]
    per_tier = ", ".join(f"tier {t}: {counts[t]}" for t in sorted(counts) if t <= top)
    lines = [f"recall: {total} hit{'s' if total != 1 else ''} for {shown} ({per_tier})"]
    named = set()
    for sid, role, pos, ts, body, tier, back, project, goal, _ in hits:
        snippet = " ".join((body if ix.fts else excerpt(body, groups)).split())[:SNIPPET]
        goal_part = f"goal: {goal} | " if goal and sid not in named else ""
        named.add(sid)                               # a session's goal is printed once
        lines.append(f"{label(tier, back, project)} | {ts[:10]} | {sid} @{pos} {role} | "
                     f"{goal_part}{snippet}")
    if total > len(hits):
        lines.append(f"(+{total - len(hits)} more not shown: narrow the wordings)")
    return lines


def current_session(value):
    sid = value or os.environ.get("CLAUDE_CODE_SESSION_ID")
    return sid if sid and SESSION_ID_RE.match(sid) else None


def cmd_search(args):
    if disabled():
        print("recall: disabled for this project (RECALL_DISABLE=1)")
        return 0
    session = current_session(args.session)
    if args.project:
        pdir = project_dir(args.project)
    else:
        f = find_transcript(session)
        pdir = f.parent if f else search_dirs()[0]
    if pdir.name in optouts():
        print("recall: disabled for this project (it opted out with RECALL_DISABLE=1)")
        return 0
    depth = args.depth if args.depth is not None else env_int("RECALL_DEPTH", 10)
    notes = []
    try:
        ix = Index()
        with ingest_lock(LOCK_WAIT) as got:
            if got:
                state = load_state()
                refresh_chain(ix, state, session, pdir, depth)
                save_json("state.json", state)
            else:
                notes.append("another ingest holds the lock; this chain was not refreshed first")
        lines = run_search(ix, args.words, session, pdir.name, depth, args.all)
    except sqlite3.DatabaseError as e:
        print(f"recall: cannot open the index ({e}). Run: recall.py rebuild")
        return 1
    if not load_state()["projects"].get(pdir.name, {}).get("done"):
        notes.append("this project's first archive run has not finished; results may be incomplete")
    if not ix.fts:
        notes.append("no FTS5 in this Python, so this was a plain unranked scan")
    print("\n".join(lines + [f"note: {n}" for n in notes]))
    return 0


# --- show, forget, rebuild, whoami ---------------------------------------------------------

def render_entry(j, e):
    head = f"--- @{j} {e.get('type')} {e.get('timestamp', '')}"
    out = [head]
    content = tr.content_of(e)
    if e.get("type") in ("user", "attachment"):
        prompt = tr.real_prompt(e)
        if prompt:
            out.append(prompt[:SHOW_CAP])
        elif e.get("isMeta"):
            out.append("(injected context, not shown)")
        for b in content if isinstance(content, list) else ():
            if isinstance(b, dict) and b.get("type") == "tool_result":
                out.append("[tool result]\n" + tr.text_of(b.get("content"))[:SHOW_CAP])
    else:
        for b in content if isinstance(content, list) else ():
            if not isinstance(b, dict):
                continue
            if b.get("type") == "text":
                out.append(b.get("text", "")[:SHOW_CAP])
            elif b.get("type") == "tool_use":
                out.append(f"[tool call] {b.get('name')} "
                           + json.dumps(b.get("input"), ensure_ascii=False)[:SHOW_CAP])
    return "\n".join(out)


def cmd_show(args):
    ix = Index()
    r = ix.db.execute("SELECT project FROM session WHERE id = ?", (args.session,)).fetchone()
    if not r:
        print(f"recall: {args.session} is not in the archive")
        return 1
    if args.pos == "note":
        try:
            print((store() / "notes" / f"{args.session}.md").read_text(encoding="utf-8"))
            return 0
        except OSError:
            print("recall: no archived note for this session")
            return 1
    sub, _, num = args.pos.rpartition(":")
    adir = store() / "archive" / r[0]
    path = adir / args.session / "subagents" / f"{sub}.jsonl.gz" if sub else \
        adir / f"{args.session}.jsonl.gz"
    try:
        i = int(num)
    except ValueError:
        print(f"recall: bad position {args.pos!r}")
        return 2
    kept = list(tr.read_entries(path))
    convo = [j for j, e in enumerate(kept) if e.get("type") in ("user", "assistant")
             or tr.queued_attachment(e) is not None]
    if not convo:
        print("recall: the archived transcript is empty or missing")
        return 1
    k = bisect.bisect_left(convo, i)
    window = convo[max(0, k - args.context): k + args.context + 1]
    print("\n".join(render_entry(j, kept[j]) for j in window))
    return 0


def cmd_forget(args):
    target = current_session(args.session) if args.target == "this" else args.target
    if not target or not SESSION_ID_RE.match(target):
        print("recall: no session id to forget")
        return 2
    with ingest_lock(LOCK_WAIT) as got:
        if not got:
            print("recall: an ingest is running; try again in a minute")
            return 1
        ix = Index()
        drop_session(ix, target, exclude=True)
        ix.db.commit()
        save_json("deny.json", sorted(denied() | {target}))
    f = find_transcript(target)
    where = f"at {f} " if f else ""
    print(f"recall: forgot {target}. Its archive copy, note copy and index rows are deleted, and "
          f"later ingests skip it. The original transcript stays {where}until Claude Code's own "
          f"cleanup (cleanupPeriodDays) deletes it.")
    return 0


def cmd_rebuild(args):
    with ingest_lock(LOCK_WAIT) as got:
        if not got:
            print("recall: an ingest is running; try again in a minute")
            return 1
        for f in store().glob("index.sqlite*"):
            f.unlink()
        ix = Index()
        count = 0
        gone, optedout = denied(), optouts()
        for gz in sorted((store() / "archive").glob("*/*.jsonl.gz")):
            sid, slug = gz.name[: -len(".jsonl.gz")], gz.parent.name
            if sid in gone or slug in optedout:
                continue                     # forgotten or opted out: it must not come back
            kept = list(tr.read_entries(gz))
            meta = tr.meta(kept)
            rows = tr.rows(kept)
            for sg in sorted((gz.parent / sid / "subagents").glob("*.jsonl.gz")):
                rows += tr.rows(list(tr.read_entries(sg)), subagent=sg.name[: -len(".jsonl.gz")])
            copy, extra, goal = note_rows(sid, meta)
            ix.put(sid, slug, meta, rows + extra, copy, goal)
            count += 1
        for marker in sorted((store() / "notes").glob("*.skip")):
            sid, info = marker.stem, read_marker(marker.stem)
            if SESSION_ID_RE.match(sid) and info.get("project") and info["project"] not in optedout \
                    and not ix.db.execute("SELECT 1 FROM session WHERE id = ?", (sid,)).fetchone():
                ix.put(sid, info["project"], {"parent": info.get("parent")}, [], excluded=True)
        ix.db.commit()
    print(f"recall: rebuilt the index from {count} archived sessions")
    return 0


def cmd_whoami(args):
    session = current_session(args.session)
    if not session:
        print("recall: CLAUDE_CODE_SESSION_ID is not set; pass --session")
        return 1
    f = find_transcript(session)
    print(f"session={session} project={f.parent if f else search_dirs()[0]}")
    return 0


# --- ingest entry points -------------------------------------------------------------------

def cmd_ingest(args):
    pdir = project_dir(args.project)
    with ingest_lock(0) as got:
        if not got:
            return 0
        ix = Index()
        state = load_state()
        ingest_project(ix, state, pdir)
        expire(ix, state)
        save_json("state.json", state)
    return 0


def spawn_ingest(pdir: Path):
    """Fully detached: own session, no inherited stdio, survives the hook and the session."""
    subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "ingest", "--project", str(pdir)],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True, close_fds=True, cwd="/")


def cmd_hook(args):
    """SessionStart on startup. Silent and fail-open: it must never affect session start."""
    try:
        data = json.loads(sys.stdin.read() or "{}")
        tp = data.get("transcript_path")
        pdir = Path(tp).parent if tp else search_dirs()[0]
        record_optout(pdir.name, disabled())
        spawn_ingest(pdir)
    except Exception:
        pass
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(prog="recall.py", description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("search")
    s.add_argument("--session")
    s.add_argument("--project")
    s.add_argument("--depth", type=int)
    s.add_argument("--all", action="store_true")
    s.add_argument("--stdin", action="store_true",
                   help="also read wordings from stdin, one per line, so a query never passes "
                        "through the shell")
    s.add_argument("words", nargs="*")
    s.set_defaults(fn=cmd_search)
    search_parser = s
    s = sub.add_parser("show")
    s.add_argument("session")
    s.add_argument("pos")
    s.add_argument("--context", type=int, default=SHOW_CONTEXT)
    s.set_defaults(fn=cmd_show)
    s = sub.add_parser("forget")
    s.add_argument("target")
    s.add_argument("--session")
    s.set_defaults(fn=cmd_forget)
    s = sub.add_parser("ingest")
    s.add_argument("--project", required=True)
    s.set_defaults(fn=cmd_ingest)
    sub.add_parser("rebuild").set_defaults(fn=cmd_rebuild)
    s = sub.add_parser("whoami")
    s.add_argument("--session")
    s.set_defaults(fn=cmd_whoami)
    sub.add_parser("hook").set_defaults(fn=cmd_hook)
    args = p.parse_args(argv)
    if args.cmd == "search":
        if args.stdin:
            args.words += [line.strip() for line in sys.stdin.read().splitlines() if line.strip()]
        elif not args.words:
            search_parser.error("give at least one wording, or --stdin")
    old = os.umask(0o077)
    try:
        return args.fn(args)
    finally:
        os.umask(old)


if __name__ == "__main__":
    sys.exit(main())
