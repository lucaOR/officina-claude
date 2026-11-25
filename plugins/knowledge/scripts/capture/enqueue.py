"""Queue extracted rows for /kb review, capped and deduplicated."""
import json

from kb import kb_queue


def _norm(s):
    return " ".join(str(s).lower().split())


def _queued_texts(root):
    """Normalised text of every row in the queue file, consumed or not."""
    path = kb_queue.queue_file_path(root)
    if not path.exists():
        return set()
    seen = set()
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if isinstance(rec, dict) and isinstance(rec.get("text"), str):
                seen.add(_norm(rec["text"]))
    return seen


def enqueue(rows, session_id, root, *, cap=6):
    """Push at most `cap` rows whose normalised statement is not queued yet. Returns the count."""
    seen = _queued_texts(root)
    written = 0
    for r in rows:
        if written >= cap:
            break
        statement = " ".join(str(r["statement"]).split())
        key = _norm(statement)
        if not statement or key in seen:
            continue
        kb_queue.push(statement, pusher="auto-capture", root=root, meta={
            "source": "auto", "session": session_id, "theme": r.get("theme"),
            "scope_guess": r.get("scope_guess"), "kind": r.get("kind"),
            "quote": r.get("quote")})
        seen.add(key)
        written += 1
    return written
