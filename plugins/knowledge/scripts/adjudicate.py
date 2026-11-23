#!/usr/bin/env python3
"""List knowledge-base findings awaiting a verdict, and record one.

  adjudicate.py --list --days 7
  adjudicate.py --key 3f2a1c9d0b8e7f65 --verdict false_positive --note "readonly class"
  adjudicate.py --miss --fqid hub/conventions#dto --file app/A.php --head 9c1f0ab \
      --service billing-api

The first two modes judge findings the engine produced. The third records one it should
have produced and did not; it takes fqid/file/head/service because there is no event to
look up.
"""
from __future__ import annotations

import argparse
import getpass
import sys
from datetime import datetime

import adjudications
import ledger
import paths
import report

# Misses first: they are what drives "promote this rule to blocking", which is exactly
# the advice that was wrong when the dto rule topped the violated list on 2026-08-18.
_ORDER = {"landed_ignored": 0, "landed_advisory": 1, "landed_ungated": 2,
          "blocked_at_commit": 3, "caught_at_edit": 4}


def pending(classified: dict, adjudicated: dict) -> list:
    """Classified instances with no verdict yet, most-in-need-of-a-verdict first."""
    out = [dict(inst, event_key=key) for key, inst in classified.items()
           if key not in adjudicated]
    return sorted(out, key=lambda i: (_ORDER.get(i["disposition"], 9), i["fqid"]))


def _record_miss(a, store):
    if not (a.fqid and a.file and a.head and a.service):
        return "--miss requires --fqid, --file, --head and --service"
    row = adjudications.build_miss_row(a.fqid, a.file, a.head,
                                       datetime.now().isoformat(timespec="seconds"),
                                       getpass.getuser(), a.note, service=a.service)
    ledger.append(store, [row])
    print(f"recorded false_negative for {a.fqid} ({a.file} @ {a.head})")
    return None


def _record_verdict(a, store, root):
    if not a.verdict:
        return "--key requires --verdict"
    rows = report.filter_rows(ledger.load_ledger(ledger.default_path(root)),
                              None, a.days)
    inst = report.classify(rows).get(a.key)
    if inst is None:
        print(f"no classified event with key {a.key} in this window", file=sys.stderr)
        sys.exit(1)
    row = adjudications.build_row(a.key, inst["fqid"], a.verdict,
                                  datetime.now().isoformat(timespec="seconds"),
                                  getpass.getuser(), a.note, service=inst.get("service"))
    ledger.append(store, [row])
    print(f"recorded {a.verdict} for {inst['fqid']} ({a.key})")
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true", help="show findings awaiting a verdict")
    ap.add_argument("--days", type=int, default=None, help="window for --list")
    ap.add_argument("--key", default=None, help="event_key to adjudicate")
    ap.add_argument("--verdict", default=None, choices=list(adjudications.EVENT_VERDICTS))
    ap.add_argument("--miss", action="store_true",
                    help="record a false negative: a violation the rule should have "
                         "caught and did not")
    ap.add_argument("--fqid", default=None, help="rule that missed (--miss only)")
    ap.add_argument("--file", default=None, help="file it missed in (--miss only)")
    ap.add_argument("--head", default=None,
                    help="short sha of the SERVICE repo the miss was seen at (--miss "
                         "only); git -C <service> rev-parse --short HEAD")
    ap.add_argument("--service", default=None, help="service the miss was seen in (--miss only)")
    ap.add_argument("--note", default="", help="why — one line, for the next reader")
    ap.add_argument("--root", default=None, help="project root (default: resolved from $CLAUDE_PROJECT_DIR or the cwd)")
    a = ap.parse_args()
    root = paths.project_root(a.root)
    if paths.skip_without_knowledge(root, "adjudicate"):
        return

    store = adjudications.default_path(root)
    adjudicated = adjudications.latest(ledger.load_ledger(store))

    if a.miss:
        err = _record_miss(a, store)
        if err:
            ap.error(err)
        return

    if a.key:
        err = _record_verdict(a, store, root)
        if err:
            ap.error(err)
        return

    rows = report.filter_rows(ledger.load_ledger(ledger.default_path(root)),
                             None, a.days)
    items = pending(report.classify(rows), adjudicated)
    if not items:
        print("nothing awaiting a verdict in this window.")
        return
    print(f"{len(items)} finding(s) awaiting a verdict:")
    for i in items:
        print(f"  {i['event_key']}  [{i['disposition']}]  {i['fqid']}")
        print(f"      {i['label']}  branch={i['branch']}")


if __name__ == "__main__":
    main()
