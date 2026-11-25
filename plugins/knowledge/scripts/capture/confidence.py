"""Deterministic confidence score and theme vocabulary for queued rows."""
from collections import Counter

LISTED_MIN = 0.35


def _meta(row):
    meta = row.get("meta") if isinstance(row, dict) else None
    return meta if isinstance(meta, dict) else {}


def score(row, rows, ledger_hits):
    """0.2 base (quote verified) + ruling bonus + cross-session recurrence + ledger hits."""
    meta = _meta(row)
    total = 0.2
    if meta.get("kind") == "user-ruling":
        total += 0.3
    theme = meta.get("theme")
    if theme:
        others = {_meta(r).get("session") for r in rows
                  if _meta(r).get("theme") == theme}
        others.discard(meta.get("session"))
        others.discard(None)
        total += 0.3 * min(len(others), 2) / 2
    total += 0.2 * min(max(int(ledger_hits or 0), 0), 2) / 2
    return total


def theme_vocab(rows, limit=30):
    """Themes by descending count, ties alphabetical; rows without a theme are skipped."""
    counts = Counter(t for t in (_meta(r).get("theme") for r in rows)
                     if isinstance(t, str) and t)
    return sorted(counts, key=lambda t: (-counts[t], t))[:limit]


def main(argv=None):
    """Print one JSON line per unconsumed `source=auto` queue row: id, text, theme, kind,
    quote, score and listed. Recurrence is counted over the whole unconsumed queue and ledger
    hits are fixed at 0, so the scribe never has to compute a score by hand."""
    import argparse
    import json
    import sys
    from pathlib import Path
    scripts = Path(__file__).resolve().parents[1]
    sys.path[:0] = [str(scripts), str(scripts / "kb")]
    from kb import kb_queue

    ap = argparse.ArgumentParser(description=main.__doc__)
    ap.add_argument("--root", required=True)
    args = ap.parse_args(argv)
    rows, _skipped = kb_queue.scan(args.root)
    for row in rows:
        meta = _meta(row)
        if meta.get("source") != "auto":
            continue
        value = score(row, rows, 0)
        print(json.dumps({
            "id": row.get("id"), "text": row.get("text"), "theme": meta.get("theme"),
            "kind": meta.get("kind"), "quote": meta.get("quote"),
            "score": round(value, 2), "listed": value >= LISTED_MIN}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
