#!/usr/bin/env python3
"""The health sweep behind `/knowledge:kb run`: what is due, and which findings the user kept.

`validate.py` runs on every `/kb run`; the full sweep (validate plus the ledger signal from
`report.py`) runs when `scribe.audit_every_days` (default 7, 0 = every run) have passed since the
last full sweep. State is `audit-state.json` in the local state dir (`paths.local_dir`):

    {"last_full": ISO timestamp | null, "kept": [{"key", "hash", "at"}]}

A finding the user chose to keep as-is is recorded with a hash of the rules it names, and stays
hidden until one of those rules changes. An ERROR is never hidden.

CLI:
    kb_audit.py [--root PATH] plan [--force]
        prints {"full": bool, "findings": [{"category", "fqids", "text"}]}
    kb_audit.py [--root PATH] keep --category C --fqid X [--fqid Y ...]
        records a finding as kept as-is
    kb_audit.py [--root PATH] mark-full
        records that a full sweep finished
Every subcommand takes --lease RUN_ID.
"""
from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPTS))

import lib  # noqa: E402
import paths  # noqa: E402

try:
    import yaml
except ImportError:
    sys.path.append(str(SCRIPTS / "vendor"))
    import yaml

STATE_NAME = "audit-state.json"


def _state_path(root: Path) -> Path:
    return paths.local_dir(Path(root)) / STATE_NAME


def _read(root: Path) -> dict:
    try:
        data = json.loads(_state_path(root).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = None
    if not isinstance(data, dict):
        data = {}
    kept = data.get("kept")
    return {"last_full": data.get("last_full"),
            "kept": [k for k in kept if isinstance(k, dict)] if isinstance(kept, list) else []}


def _write(root: Path, state: dict) -> None:
    path = _state_path(root)
    tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _now(now: datetime | None) -> datetime:
    return now if now is not None else datetime.now(timezone.utc)


def last_full(root: Path) -> datetime | None:
    try:
        stamp = datetime.fromisoformat(_read(root)["last_full"])
    except (TypeError, ValueError):
        return None
    return stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)


def due(root: Path, now: datetime | None = None) -> bool:
    """True when the full sweep should run: never run, or `audit_every_days` have passed.
    `audit_every_days == 0` makes it due on every run."""
    days = lib.load_config(Path(root))["scribe"]["audit_every_days"]
    stamp = last_full(root)
    if stamp is None or days == 0:
        return True
    return _now(now) - stamp >= timedelta(days=days)


def mark_full(root: Path, now: datetime | None = None) -> None:
    state = _read(root)
    state["last_full"] = _now(now).isoformat()
    _write(root, state)


def finding_key(category: str, fqids: list) -> str:
    return category + "|" + ",".join(sorted(fqids))


def _rule_map(root: Path) -> dict:
    return {r.fqid: r for r in lib.load_all(lib.scope_roots(Path(root)))}


def _hash(rules: dict, fqids: list) -> str:
    digest = hashlib.sha256()
    for fqid in sorted(fqids):
        rule = rules.get(fqid)
        dump = (yaml.safe_dump(dataclasses.asdict(rule), sort_keys=True,
                               allow_unicode=True) if rule else "<missing>\n")
        digest.update(f"{fqid}\n{dump}".encode("utf-8"))
    return digest.hexdigest()


def rules_hash(root: Path, fqids: list) -> str:
    """sha256 over the canonical YAML dump of each named rule, sorted by FQID."""
    return _hash(_rule_map(root), fqids)


def keep(root: Path, category: str, fqids: list) -> None:
    """Record a finding as kept as-is, against the rules' current content."""
    state = _read(root)
    key = finding_key(category, fqids)
    state["kept"] = [k for k in state["kept"] if k.get("key") != key]
    state["kept"].append({"key": key, "hash": rules_hash(root, fqids),
                          "at": _now(None).isoformat()})
    _write(root, state)


def filter_kept(root: Path, findings: list) -> list:
    """Drop findings the user kept while the rules they name are unchanged. ERROR stays."""
    kept = {k.get("key"): k.get("hash") for k in _read(root)["kept"]}
    if not kept:
        return list(findings)
    rules = _rule_map(root)
    return [f for f in findings
            if f["category"] == "ERROR"
            or kept.get(finding_key(f["category"], f["fqids"])) != _hash(rules, f["fqids"])]


def _engine(root: Path, script: str, flag: str) -> list:
    """Findings from `validate.py --json` or `report.py --findings`. Exit 1 is validate's normal
    answer for a base with errors; anything else without parseable output is a failure."""
    proc = subprocess.run([sys.executable, str(SCRIPTS / script), flag, "--root", str(root)],
                          capture_output=True, text=True)
    try:
        return json.loads(proc.stdout)
    except ValueError:
        if not proc.stdout.strip() and proc.returncode == 0:
            return []                               # no knowledge base: the engine stays silent
        raise SystemExit(f"kb_audit: {script} failed ({proc.returncode}): {proc.stderr.strip()}")


def plan(root: Path, force: bool = False, now: datetime | None = None) -> dict:
    full = force or due(root, now)
    found = _engine(root, "validate.py", "--json")
    if full:
        found += _engine(root, "report.py", "--findings")
    return {"full": full, "findings": filter_kept(root, found)}


def main(argv: list | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", default=None,
                    help="project root (default: resolved from $CLAUDE_PROJECT_DIR or the cwd)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_plan = sub.add_parser("plan")
    p_plan.add_argument("--force", action="store_true", help="run the full sweep even if not due")
    p_keep = sub.add_parser("keep")
    p_keep.add_argument("--category", required=True)
    p_keep.add_argument("--fqid", action="append", default=[], required=True)
    sub.add_parser("mark-full")
    for p in sub.choices.values():
        lib.add_lease_arg(p)
    a = ap.parse_args(argv)
    root = paths.project_root(a.root)
    lib.touch_lease(root, a)
    if a.cmd == "plan":
        print(json.dumps(plan(root, a.force), indent=2))
    elif a.cmd == "keep":
        keep(root, a.category, a.fqid)
    else:
        mark_full(root)
    return 0


if __name__ == "__main__":
    sys.exit(main())
