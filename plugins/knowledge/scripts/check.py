#!/usr/bin/env python3
"""Diff -> matched rules -> run executable checks -> checklist (deterministic mode)."""
from __future__ import annotations

import argparse
import functools
import os
import re
import subprocess
import sys
import tempfile
import uuid
from datetime import datetime
from pathlib import Path

import ledger
import lib
import paths

_OPS = {">": lambda a, b: a > b, "<": lambda a, b: a < b, ">=": lambda a, b: a >= b,
        "<=": lambda a, b: a <= b, "==": lambda a, b: a == b, "!=": lambda a, b: a != b}


def _run_count(cmd: str, root: Path):
    """Run a shell command; return its numeric stdout as int, or None if non-numeric."""
    proc = subprocess.run(cmd, shell=True, capture_output=True, text=True, cwd=str(root))
    try:
        return int(proc.stdout.strip())
    except ValueError:
        return None


def _flags(count, flag_when: str):
    """Apply the flag_when comparison to a count. True=violation, False=clean, None=inconclusive."""
    if count is None:
        return None
    m = re.match(r"\s*(>=|<=|==|!=|>|<)\s*(\d+)\s*$", flag_when or "")
    if not m:
        return None
    return _OPS[m.group(1)](count, int(m.group(2)))


@functools.lru_cache(maxsize=None)
def _is_git_repo(root: Path) -> bool:
    return subprocess.run(["git", "-C", str(root), "rev-parse", "--git-dir"],
                          capture_output=True, text=True).returncode == 0


def _show(root: Path, ref: str, rel_path: str):
    """Content of rel_path at ref, or None if absent in ref."""
    proc = subprocess.run(["git", "-C", str(root), "show", f"{ref}:{rel_path}"],
                          capture_output=True, text=True)
    return proc.stdout if proc.returncode == 0 else None


@functools.lru_cache(maxsize=None)
def _git_state(root: Path):
    """(branch, short HEAD) for the repo the files are being evaluated in, or
    (None, None) outside a repo. Recorded on every ledger row: the 2026-08-18 fail
    spike came entirely from a branch that was not checked out, and without these the
    rows are unattributable. HEAD is also half of the event identity — both hooks judge
    against `--baseline HEAD` and HEAD does not move between them, which is what lets
    an edit-phase row and a commit-phase row be recognised as the same violation."""
    if not _is_git_repo(root):
        return None, None

    def one(*args):
        proc = subprocess.run(["git", "-C", str(root), *args], capture_output=True,
                              text=True)
        return (proc.stdout.strip() or None) if proc.returncode == 0 else None

    return one("rev-parse", "--abbrev-ref", "HEAD"), one("rev-parse", "--short", "HEAD")


def _build_cmd(shell: str, targets: list, scope: str, root: Path) -> str:
    """Substitute {uc_web} (repo root — for tooling/rule-file paths like ast-grep rules),
    then {file}/{files}."""
    shell = shell.replace("{uc_web}", str(root))
    if scope == "project":
        return shell.replace("{files}", " ".join(targets))
    return shell.replace("{file}", targets[0])


def _baseline_count(check: dict, root: Path, label_paths: list, ref: str):
    """Count for the same check at `ref`. None => baseline unavailable; _eval_check then falls back to the absolute flag verdict.
    Paths absent in ref (new files) contribute nothing; all-absent => 0."""
    if not _is_git_repo(root):
        return None
    tmps = []
    try:
        base_paths = []
        for p in label_paths:
            content = _show(root, ref, p)
            if content is None:
                continue
            tf = tempfile.NamedTemporaryFile("w", suffix=Path(p).suffix, delete=False)
            tf.write(content)
            tf.close()
            tmps.append(tf.name)
            base_paths.append(tf.name)
        if not base_paths:
            return 0
        cmd = _build_cmd(check["shell"], base_paths, check.get("scope", "file"), root)
        return _run_count(cmd, root)
    finally:
        for t in tmps:
            try:
                os.unlink(t)
            except OSError:
                pass


def _worsened(flag_when: str, working: int, base: int) -> bool:
    """Did the change move the metric further into violation vs the baseline? Higher-is-worse
    for >/>= ; lower-is-worse for </<= ; for ==/!= there is no monotone 'worse', so any
    flagging working value is treated as reportable."""
    m = re.match(r"\s*(>=|<=|==|!=|>|<)", flag_when or "")
    op = m.group(1) if m else ">"
    if op in (">", ">="):
        return working > base
    if op in ("<", "<="):
        return working < base
    return True


def _eval_check(check: dict, root: Path, label_paths: list, baseline):
    """Outcome (fail/pass/inconclusive) for one check. In baseline mode, fail only when the
    working count flags AND exceeds the baseline count (introduced or worsened)."""
    cmd = _build_cmd(check["shell"], label_paths, check.get("scope", "file"), root)
    working = _run_count(cmd, root)
    flag = _flags(working, check.get("flag_when", ""))
    if not baseline or flag is not True:
        return _outcome(flag)
    base = _baseline_count(check, root, label_paths, baseline)
    if base is None:
        return _outcome(flag)
    return "fail" if _worsened(check.get("flag_when", ""), working, base) else "pass"


def _outcome(result):
    if result is True:
        return "fail"
    if result is False:
        return "pass"
    return "inconclusive"


def evaluate(root: Path, files: list, service, rules: list, baseline=None, include_sweep_only=False):
    """Full census: [(Rule, label, outcome)] for every matched rule. Pass rules already
    resolved via lib.resolve_overrides. With `baseline` (a git ref), count-checks report a
    violation only when the change introduced/worsened it. outcome in {reminder, pass, fail,
    inconclusive}. `label` is a file path (file/class scope) or a comma-and-space-joined list
    (project scope). `include_sweep_only` also matches `sweep_only` rules — set only by the
    review-sweep caller; every other caller of THIS engine (check-on-edit.py, the
    knowledge-check skill) leaves them out so a broad-glob judgment rule reminds once per
    sweep, not once per commit. Note this governs the reminder channel only. The other
    on-edit hook, inject-rules-on-edit.py, does not run this engine at all: it calls
    lib.file_matches() directly with include_sweep_only=True, because a rule's BODY still
    helps at authoring time even when its reminder has been deferred to review. `no_jit` is
    the opt-out over there, and it does not reach this function."""
    records = []
    for r in rules:
        matched = [f for f in files if lib.file_matches(r, f, service, include_sweep_only)]
        if not matched:
            continue
        if not r.check:
            records.extend((r, f, "reminder") for f in matched)
            continue
        if r.check.get("scope", "file") == "project":
            records.append((r, ", ".join(matched), _eval_check(r.check, root, matched, baseline)))
            continue
        for f in matched:                       # "file" or "class" (PHP: one class per file)
            records.append((r, f, _eval_check(r.check, root, [f], baseline)))
    return records


def partition(records):
    """Derive the printed lists from the census."""
    violations = [(r, label) for (r, label, o) in records if o == "fail"]
    reminders = [(r, label) for (r, label, o) in records if o == "reminder"]
    return violations, reminders


_QUIET_PHASES = ("edit", "commit")


def _ledger_records(records, phase: str):
    """What is worth persisting at this phase.

    `edit` fires on every write and `commit` on every commit, and at both the reminder
    rows would be one row per matched checkless rule per run — 327 of the 342 rules carry
    no check, so that is the difference between a ledger that grows with the work and one
    that grows with the registry. `sweep` and `adhoc` keep them, because the sweep's
    reminder census is the only usage signal the checkless rules have.

    Deliberately NOT keyed on --checks-only. The two coincide today, but that flag means
    "do not print reminders to this caller" and this decision means "this phase runs too
    often to store them". Coupling them makes any future quiet caller silently lose its
    usage data."""
    if phase not in _QUIET_PHASES:
        return records
    return [rec for rec in records if rec[2] != "reminder"]


def _write_ledger(records, service, source, phase, root, baseline, keyed, ledger_root):
    """Append the census to the local ledger. Fail-silent: the engine and the git
    hook must never break on a ledger write. Disable with KB_LEDGER=0."""
    if os.environ.get("KB_LEDGER") == "0":
        return
    try:
        branch, head = _git_state(root)
        rows = ledger.build_rows(_ledger_records(records, phase), service, source,
                                 datetime.now().isoformat(timespec="seconds"),
                                 uuid.uuid4().hex[:8], phase=phase, branch=branch,
                                 head=head, baseline=baseline, keyed=keyed)
        ledger.append(ledger.default_path(ledger_root), rows)
    except Exception:
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--service", default=None,
                    help="service folder name; omit for cross-service-only check")
    ap.add_argument("--checks-only", action="store_true",
                    help="run only executable checks; suppress judgment-rule reminders (for git hooks)")
    ap.add_argument("--include-sweep-only", action="store_true",
                    help="also match sweep_only rules (for code-review-sweep only; every other CLI caller omits this)")
    ap.add_argument("--source", default="adhoc", choices=["skill", "hook", "adhoc"],
                    help="who invoked the engine; recorded in the ledger")
    ap.add_argument("--baseline", default=None,
                    help="git ref (e.g. HEAD): report only violations the change introduced or worsened")
    ap.add_argument("--phase", default=None, choices=["edit", "commit", "sweep", "adhoc"],
                    help="where in the authoring cycle this run sits; recorded in the "
                         "ledger and used to classify a violation as caught or landed. "
                         "Defaults to 'commit' for --source hook, else 'adhoc'.")
    ap.add_argument("files", nargs="+", help="paths relative to the service root")
    ap.add_argument("--eval-root", default=None,
                    help="directory the file paths are relative to; defaults to the service folder. "
                         "Needed for a registry shared by several trees, which has one scope but "
                         "a checkout per consumer (e.g. --eval-root api/shared-lib)")
    ap.add_argument("--root", default=None, help="project root (default: resolved from $CLAUDE_PROJECT_DIR or the cwd)")
    lib.add_lease_arg(ap)
    a = ap.parse_args()
    if a.source == "hook" and a.phase is None:
        ap.error("--source hook must also pass --phase explicitly (edit or commit); "
                 "the implicit fallback below exists only for --source skill/adhoc callers.")
    root = paths.project_root(a.root)
    if paths.skip_without_knowledge(root, "check"):
        return
    lib.touch_lease(root, a)
    registry = lib.registry_root(root, a.service) if a.service else None
    roots = [root] + ([registry] if registry else [])
    eval_root = (root / a.eval_root) if a.eval_root else ((root / a.service) if a.service else root)
    rules = lib.load_all(roots)
    effective, conflicts = lib.resolve_overrides(rules, a.service)
    records = evaluate(eval_root, a.files, a.service, effective, baseline=a.baseline,
                       include_sweep_only=a.include_sweep_only)
    violations, reminders = partition(records)
    printed_reminders = [] if a.checks_only else reminders

    phase = a.phase or ("commit" if a.source == "hook" else "adhoc")
    # The root repository itself has neither the edit hook nor the commit gate, so its violations
    # could never have been caught by either; keeping them out of the event model stops
    # every KB edit from reading as a coverage failure. They stay in the census.
    _write_ledger(records, a.service, a.source, phase, eval_root, a.baseline,
                  keyed=eval_root != root, ledger_root=root)

    if conflicts and not a.checks_only:
        print("WARN (knowledge-base graph — run validate.py for the full lint):")
        for kind, subject, target in conflicts:
            print(f"  {kind}: {subject} -> {target}")
    if violations:
        print("VIOLATIONS:")
        for r, f in violations:
            print(f"  [{r.severity}] {r.fqid} — {f}")
            print(f"      {' '.join((r.rule or r.title).split())}")
    if printed_reminders:
        print("REVIEW (judgment rules — verify manually):")
        for r, f in printed_reminders:
            print(f"  [{r.severity}] {r.fqid} — {f} · {r.trigger}")
    if not violations and not printed_reminders and not a.checks_only:
        print("No matching rules for the given files.")
    sys.exit(1 if any(r.severity == "blocking" for r, _ in violations) else 0)


if __name__ == "__main__":
    main()
