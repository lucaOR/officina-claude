#!/usr/bin/env python3
"""Count rules NAMED IN AN ANSWER, offline, from the session transcripts.

Citation is the strongest of the four usage channels: jit_delivered says a rule reached
the context window, cited says it reached a conclusion.

Counting this naively is off by roughly 50x. Measured on 2026-08-18, a raw grep for one
fqid across the transcript directory returned 592 hits against a true count of 12. Both
sources of inflation are structural, not sampling noise:

  * The digest is injected as an ATTACHMENT and lists every rule's fqid on its `also:`
    lines, so every session that started reads as a citation of all 339 rules.
  * check.py stdout lands in `tool_result` blocks, so every hook firing reads as a
    citation of whatever the hook happened to print.

Filtering to `type: "assistant"` records and, inside them, to content blocks of
`type: "text"` removes both — attachments are not assistant records and tool results are
role "user" blocks. `thinking` blocks fall out of the same filter, which is what we want:
a rule weighed and discarded in reasoning did not reach the answer.

Timestamps are the transcript's own, normalised from `2026-08-18T10:00:00.000Z` to
`2026-08-18T10:00:00` so they sort against ledger rows. Those are UTC while the ledger
writes local time, so a row can land in the wrong bucket by the UTC offset — hours, not
days. It matters only for a row sitting within that offset of a window edge.

This is a re-runnable offline scan, not a hook. Re-running it re-emits rows already in
the store, so it truncates the `cited` rows it owns before writing."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import ledger
import lib
import paths
import report
import usage


def default_transcripts(root: Path) -> Path:
    """Claude Code names a project's transcript folder after its path, with "/" and "." as "-"."""
    return (Path.home() / ".claude" / "projects"
            / str(root).replace("/", "-").replace(".", "-"))


def _ts(raw):
    """`2026-08-18T10:00:00.000Z` -> `2026-08-18T10:00:00`, matching the ledger shape."""
    if not isinstance(raw, str):
        return ""
    return raw.rstrip("Z").split(".")[0]


def assistant_texts(path: Path) -> list:
    """(ts, session, text) for every assistant-authored text block in one transcript.

    Everything else is dropped on purpose — see the module docstring for the two
    inflation sources this filter exists to remove."""
    out = []
    try:
        lines = Path(path).read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return out
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except (json.JSONDecodeError, TypeError):
            continue
        if rec.get("type") != "assistant":
            continue
        message = rec.get("message")
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        content = message.get("content")
        if not isinstance(content, list):
            continue
        ts = _ts(rec.get("timestamp"))
        session = rec.get("sessionId") or rec.get("session_id")
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text = block.get("text")
                if isinstance(text, str) and text:
                    out.append((ts, session, text))
    return out


def count_in(texts: list, fqids) -> dict:
    """{(session, fqid): (earliest_ts, hits)}. Substring match on the full fqid, which
    is unambiguous: an fqid carries both its scope path and its `#id`, so it cannot
    collide with prose or with another rule's id."""
    out = {}
    for ts, session, text in texts:
        for fqid in fqids:
            hits = text.count(fqid)
            if not hits:
                continue
            key = (session, fqid)
            prev_ts, prev_hits = out.get(key, (None, 0))
            earliest = ts if prev_ts is None else min(prev_ts, ts)
            out[key] = (earliest, prev_hits + hits)
    return out


def scan(transcript_dir: Path, fqids: set) -> list:
    """Usage rows, channel `cited`, one per (session, fqid) across every transcript."""
    texts = []
    for path in sorted(Path(transcript_dir).glob("*.jsonl")):
        texts.extend(assistant_texts(path))
    return [usage.build_row(fqid, "cited", ts, session, count=hits)
            for (session, fqid), (ts, hits) in sorted(count_in(texts, fqids).items())]


def _rewrite_cited(store: Path, rows: list) -> None:
    """Replace the store's `cited` rows with `rows`, leaving every other channel alone.

    The scan is re-runnable over the whole transcript history, so appending would
    double-count every previous session on every run. Writes to a sibling temp file and
    renames it into place atomically, so a concurrent appender (inject-rules-on-edit.py)
    never observes a truncated or partially-written store — though a row appended by that
    concurrent writer strictly between this function's read and its rename is still lost by
    design; only a single shared lock across both writers would close that, and neither
    writer holds one today."""
    kept = [r for r in ledger.load_ledger(store) if r.get("channel") != "cited"]
    store.parent.mkdir(parents=True, exist_ok=True)
    tmp = store.with_suffix(store.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        for row in kept + rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    tmp.replace(store)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--transcripts", default=None,
                    help="directory of *.jsonl session transcripts (default: this project's Claude Code folder)")
    ap.add_argument("--dry-run", action="store_true",
                    help="print the totals; write nothing")
    ap.add_argument("--root", default=None, help="project root (default: resolved from $CLAUDE_PROJECT_DIR or the cwd)")
    a = ap.parse_args()
    root = paths.project_root(a.root)
    if paths.skip_without_knowledge(root, "citations"):
        return

    directory = Path(a.transcripts) if a.transcripts else default_transcripts(root)
    if not directory.is_dir():
        print(f"no transcript directory at {directory}", file=sys.stderr)
        sys.exit(1)

    fqids = {r.fqid for r in lib.load_all(report.default_roots(root))}
    rows = scan(directory, fqids)
    per_rule = {}
    for row in rows:
        per_rule[row["fqid"]] = per_rule.get(row["fqid"], 0) + row["count"]

    print(f"{len(rows)} (session, rule) citations across {len(per_rule)} rules")
    for fqid, n in sorted(per_rule.items(), key=lambda kv: -kv[1])[:20]:
        print(f"  {n:5d}  {fqid}")
    if a.dry_run:
        print("\n--dry-run: nothing written")
        return
    _rewrite_cited(usage.default_path(root), rows)
    print(f"\nwrote {len(rows)} cited rows to {usage.default_path(root)}")


if __name__ == "__main__":
    main()
