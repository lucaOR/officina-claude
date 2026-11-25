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
