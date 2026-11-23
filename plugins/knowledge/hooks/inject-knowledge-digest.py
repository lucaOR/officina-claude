#!/usr/bin/env python3
"""SessionStart hook: inject the cross-service digest + the knowledge-check and knowledge-capture
dispatch rules.

The dispatch text names a BOUNDARY, not a state. It used to read "before declaring any work
complete", which a session ending each turn on a finished ledger task or todo item reads as every
turn -- so both skills fired per turn, ~2.8k tokens of skill body plus a diff re-read each time,
none of which leaves context again. Capture was also wrong on correctness there, because a rule
drafted mid-task is drafted before its evidence is in. Event gating lives in hooks that can see
the event: check-on-edit.py checks each edit. Capture's own boundary is the review flow --
code-review-sweep runs knowledge-check then knowledge-capture at its close -- which is why the
Stop-time nudge (nudge-capture-on-failure.py) is unwired. This text only has to keep the model
from inventing a cadence of its own.

The digest does not survive a `/clear` or a compaction. The harness discards the context and
re-runs this hook, so every firing is a fresh ~3k-token cache write rather than a cached prefix
that carries over. On the `compact` source that write buys the least, because the compaction
summary already carries the task and check-on-edit.py re-injects the rules an edit actually
touches. What the summary does NOT carry is the dispatch text above, since compaction drops
injected attachments along with everything else -- and without it the model reinvents a per-turn
cadence, which costs ~2.8k tokens EVERY turn instead of ~3k once. So `compact` gets the dispatch
text plus a pointer, and pays for the index only if it goes and reads it.

`resume` used to be absent from the matcher, so a resumed session got neither the dispatch text
nor the index -- a gap rather than a saving, since the attachment an earlier firing emitted is NOT
in the replayed transcript (attachments are filtered out of the log for non-ant users unless
CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT is set, which it is not here). It is in the matcher now,
and it takes the same slim shape as `compact` for the same reason: what a resumed session lacks is
the dispatch text, not the rules themselves. The replayed conversation is strictly richer than a
compaction summary, check-on-edit.py still re-injects the rules an edit touches, and the pointer
below tells the model where to read the index -- so the one failure mode that would justify the
full ~3k-token write (a session that cannot know the index exists) does not apply.

Three facts about `resume` were measured on 2.1.228 rather than assumed, because the matcher is
shared with three sibling hooks. The harness fires SessionStart with the literal source "resume".
The session_id is UNCHANGED across a resume, so pair-brief.py's identity stamp rewrites the value
it already held. And the attachment is appended at the TAIL of the replayed transcript, after the
prior turn, so injecting here does not invalidate the cached prefix of the replayed history.
"""
import contextlib
import hashlib
import io
import json
import os
import sys
import tempfile
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import build_digest  # noqa: E402  (needs the sys.path line above)
import ledger  # noqa: E402
import lib  # noqa: E402
import paths  # noqa: E402

DIGEST_REL = Path(".claude") / "knowledge" / "_digest.md"

DISPATCH = (
    "Project knowledge base is active. Two skills maintain it, each at ONE boundary — never "
    "per turn, never after each ledger task or todo item. (1) `knowledge:knowledge-check`: run once "
    "before a commit, or before you call the work done, to verify the whole diff against the "
    "rules; every single edit is already checked automatically by a PostToolUse hook, so do "
    "not re-run it turn by turn. (2) `knowledge:knowledge-capture`: run once when the work closes — "
    "before the commit that ends it, or before a `/clear` — so a rule is written only after "
    "the evidence for it is in; a review sweep runs both at its close. When in "
    "doubt whether something is a new rule, an update to one, or memory, ASK rather than "
    "silently dropping or mis-filing it."
)

INDEX_FOLLOWS = (
    " The always-loaded cross-service rule index follows; full rule bodies live in "
    ".claude/knowledge/*.yaml, and per-service rules load when you open a service's files."
)

INDEX_ON_DEMAND = (
    " The cross-service rule index is NOT in this context: compaction discarded it, and "
    "re-injecting it would be a fresh ~3k-token cache write for an index the summary did not "
    "need. Read .claude/knowledge/_digest.md when you want the rule list. Full rule bodies "
    "live in .claude/knowledge/*.yaml, and per-service rules load when you open a service's "
    "files."
)

INDEX_ON_DEMAND_RESUME = (
    " The cross-service rule index is NOT in this context: hook attachments are not replayed "
    "with a resumed transcript, and re-injecting it would be a fresh ~3k-token cache write for "
    "an index the replayed conversation did not need. Read .claude/knowledge/_digest.md when "
    "you want the rule list. Full rule bodies live in .claude/knowledge/*.yaml, and per-service "
    "rules load when you open a service's files."
)


def read_source(stdin_text):
    """The SessionStart payload's `source`: startup | resume | clear | compact.

    Anything unreadable falls back to "startup", which serves the full digest. A wrong guess in
    that direction costs one cache write; the other direction would silently strip the index out
    of a cold session, and a session that never had the index cannot know to go and read it.
    """
    try:
        source = json.loads(stdin_text).get("source")
    except (ValueError, AttributeError):
        return "startup"
    return source if isinstance(source, str) else "startup"


def build_context(source, digest):
    if source == "compact":
        body = DISPATCH + INDEX_ON_DEMAND
    elif source == "resume":
        body = DISPATCH + INDEX_ON_DEMAND_RESUME
    else:
        body = DISPATCH + INDEX_FOLLOWS + "\n\n" + digest
    return "<EXTREMELY_IMPORTANT>\n" + body + "\n</EXTREMELY_IMPORTANT>"


def rent_path(root):
    return paths.metrics_file(root, "kb-digest-rent.jsonl")


def record_rent(root, source, context):
    """One row per firing: the source and the bytes this firing actually emitted.

    Rent is not digest_bytes x SessionStart firings. build_context() appends the digest
    body only on the `else` branch, so `compact` and `resume` emit a dispatch preamble
    plus an on-demand pointer and no digest at all — counting every firing at full price
    overstates the cost of the knowledge base by however often the session compacts.

    Recording the emitted size rather than deriving it from `source` means this stays
    true if that branch logic ever changes. Fail-silent: this hook runs at session start
    and must never be the reason a session fails to start."""
    try:
        ledger.append(rent_path(root), [{
            "ts": datetime.now().isoformat(timespec="seconds"),
            "source": source,
            "bytes": len(context.encode("utf-8")),
        }])
    except Exception:
        pass


def source_hash(kdir):
    """sha256 over every registry file of one scope: relative path, then bytes, in sorted
    order. Per-machine state under `.local` is not source and is skipped."""
    digest = hashlib.sha256()
    for path in sorted(kdir.rglob("*.yaml")):
        rel = path.relative_to(kdir)
        if ".local" in rel.parts:
            continue
        digest.update(rel.as_posix().encode("utf-8") + b"\0" + path.read_bytes() + b"\0")
    return digest.hexdigest()


def write_atomic(path, data):
    """Replace `path` with `data` via a temp file beside it; never leaves the temp behind.
    The result keeps the old file's mode plus at least rw-r--r--, or gets 0644 when it is
    new: mkstemp creates the temp file 0600, and a user with another uid (a devcontainer)
    must still read a digest. The floor also heals a 0600 left by an earlier version."""
    try:
        mode = (path.stat().st_mode & 0o777) | 0o644
    except OSError:
        mode = 0o644
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def repair_digests(root, config):
    """Re-render each scope's committed digest when that scope's YAML changed since the hash
    last recorded on this machine, so a pull or a hand edit cannot leave a stale digest in
    the session. Writes only when the rendered bytes differ. A scope whose YAML does not
    parse (a merge left conflict markers) keeps its digest and its recorded hash. Scopes
    without a digest are not managed here. Fail-silent: the session must still start."""
    try:
        hash_path = paths.local_dir(root) / "sources.hash"
        try:
            stored = json.loads(hash_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            stored = {}
        if not isinstance(stored, dict):
            stored = {}
        current = dict(stored)
        for scope in lib.scope_roots(root, config):
            kdir = scope / ".claude" / "knowledge"
            digest = kdir / "_digest.md"
            if not digest.is_file():
                continue
            try:
                key = kdir.relative_to(root).as_posix()
                now = source_hash(kdir)
                if stored.get(key) == now:
                    continue
                text = build_digest.render(lib.load_all([scope]), config).encode("utf-8")
                if digest.read_bytes() != text:
                    write_atomic(digest, text)
            except Exception:
                continue
            current[key] = now
        if current != stored:
            write_atomic(hash_path, json.dumps(current, sort_keys=True).encode("utf-8"))
    except Exception:
        pass


def main():
    root = paths.project_root()
    if not paths.has_knowledge(root):
        return
    # isatty guard so a manual run does not hang waiting on a stdin nobody is piping.
    stdin_text = "" if sys.stdin.isatty() else sys.stdin.read()
    if stdin_text.strip():
        try:
            json.loads(stdin_text)
        except ValueError:
            return          # unparseable input is not a SessionStart: stay silent
    with contextlib.redirect_stderr(io.StringIO()):
        config = lib.load_config(root)
    repair_digests(root, config)
    digest_path = root / DIGEST_REL
    if not digest_path.is_file():
        return
    source = read_source(stdin_text)
    context = build_context(source, digest_path.read_text(encoding="utf-8"))
    record_rent(root, source, context)
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": context,
    }}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass          # fail-open: never be the reason a session fails to start
