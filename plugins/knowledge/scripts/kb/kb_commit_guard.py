#!/usr/bin/env python3
"""Commit-safety guard for the knowledge-base distillation flow.

Snapshot a commit pathspec before and after a run's writes, diff the two snapshots against an
explicit write-manifest to catch a foreign writer touching the pathspec mid-run, and roll back
this run's own writes on abort — all against REAL git state, never git state inferred by
inspection. Real, observed collisions this guard exists to catch: commits 96b2b4b and 4ced3df in
this repo's history, where a foreign writer touched files inside a commit pathspec mid-run.

A project may keep each <service>/.claude as a symlink into a root-tracked directory (for
example svc/.claude -> ../umbrella/svc/.claude). Staging or diffing THROUGH the symlinked path
fails ("fatal: pathspec '...' is beyond a symbolic link"); only the real path works for git
operations, even though plain file I/O succeeds through either form. The config's
scribe.path_translations names that mapping, and every path this module hands to git is
normalized through it first — see normalize_path() — never after.

Repo root and the git-invoking callable are both explicit parameters throughout, mirroring the
convention already established in this codebase:
  - .claude/scripts/pair/pair_resolve.py takes pairs_dir=/sessions_dir=/alive= as overridable
    parameters with real-value module defaults, so tests inject a throwaway directory or a fake
    collaborator instead of monkeypatching module globals.
  - .claude/scripts/kb/kb_queue.py's repo_root() resolves the root via `git rev-parse
    --show-toplevel` from an explicit, overridable `start`, not a value baked in at import time.
This module follows the same shape (`run=run_git` is this module's `alive=pid_alive`), except
`root` itself is a REQUIRED parameter on every safety-relevant function rather than an
auto-resolved default: a guard that deletes/restores files must never silently guess where it is
operating. repo_root() exists as the one place a caller resolves it, once, up front.

Tested exclusively against real throwaway `git init` repos (see test_kb_commit_guard.py) — the
design behind this guard was burned twice by getting git's exit-code semantics wrong by inspection
instead of by testing against real git.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path
from typing import NamedTuple

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import lib  # noqa: E402
import paths  # noqa: E402


class GitError(RuntimeError):
    """A git invocation returned an exit code this module has no defined meaning for — e.g. `git
    rev-parse --verify` exiting neither 0 nor 1, most commonly because cwd is not inside any git
    work tree at all (exit 128, "fatal: not a git repository"). Never treat this as license to
    fall back to a default action (in particular: never treat it as license to `rm -f`)."""


def run_git(args: list, cwd) -> tuple:
    """Run git with `args` against `cwd` (via `git -C <cwd> ...`, matching the subprocess style
    already used in check.py). Returns (returncode, stdout, stderr) and
    never raises on a nonzero exit, and never interprets it — callers decide what a given code
    means, because in this module the same 'nonzero' ranges from meaningful (rev-parse --verify's
    exit 1: "not found") to a hard error (128: "not a repo"). This is the one seam every function
    below is written against, so a test can inject a fake with the same signature (see
    test_case5b_* in test_kb_commit_guard.py) without touching a single real git process."""
    proc = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True)
    return proc.returncode, proc.stdout, proc.stderr


def repo_root(start=None) -> Path:
    """The project root (see paths.project_root): `start` when given, else
    $CLAUDE_PROJECT_DIR or the cwd, lifted to the superproject inside a submodule.
    Raises GitError when that root is not inside any git work tree — a caller needs to
    know that immediately, not receive a root that silently doesn't exist."""
    root = paths.project_root(start)
    code, _, err = run_git(["rev-parse", "--git-dir"], root)
    if code != 0:
        raise GitError(f"{root} is not inside a git work tree: {err.strip()}")
    return root


def translate(rel: str, root, config: dict) -> str:
    """Apply `scribe.path_translations` to a repo-root-relative path. Each entry maps a
    template such as `{service}/.claude` to another (`umbrella/{service}/.claude`), and applies
    only when the path's matching prefix is actually a symlink under `root`. Anything else
    passes through unchanged: a real directory, a path already in the target form, a path with
    fewer than two segments, or a config with no translations. Idempotent."""
    s = str(rel)
    translations = config["scribe"]["path_translations"]
    if not translations:
        return s
    trailing_slash = "/" if s.endswith("/") and s != "/" else ""
    parts = Path(s).parts
    if len(parts) < 2:
        return s
    path = "/".join(parts)
    for entry in translations:
        pattern = re.escape(entry["from"]).replace(re.escape("{service}"), "(?P<service>[^/]+)")
        m = re.match(f"({pattern})(?:/|$)", path)
        if not m or not (Path(root) / m.group(1)).is_symlink():
            continue
        target = entry["to"].replace("{service}", m.groupdict().get("service") or "")
        return target + path[len(m.group(1)):] + trailing_slash
    return s


def normalize_path(rel_path, root, config: dict | None = None, *,
                   lease: str | None = None) -> str:
    """Translate `rel_path` through the config's symlink translations (see translate()).
    Must run BEFORE `rel_path` is used in any git operation — staging or diffing through the
    symlinked form fails outright, even though plain file I/O through it succeeds. `config`
    defaults to the project's own config.yaml. `lease` (here and on every public function below)
    is the /kb run id: given, the call refreshes that run's lease."""
    lib.refresh_lease(root, lease)
    config = config if config is not None else lib.load_config(Path(root))
    return translate(str(rel_path), root, config)


class PathEscapesRootError(ValueError):
    """A manifest path resolved outside `root`. A guard that deletes/restores files must never
    silently accept a path it cannot prove is inside the repo it is operating on."""


def to_manifest_path(path, root, cwd=None) -> str:
    """Construction-time resolver for one write-manifest entry: turn `path` (which may be given
    relative to `cwd` — default os.getcwd() — or as an absolute path) into a canonical
    repo-root-relative, symlink-normalized string. Call this ONCE, when a path is queued for this
    run's manifest — never re-derive it later against a possibly-different cwd. The same logical
    path must resolve identically no matter which directory the caller happened to be invoked
    from, and it must resolve identically BEFORE it ever reaches the rollback predicate.

    Raises PathEscapesRootError if `path`/`cwd` resolve outside `root` — `os.path.relpath` returns
    a '../'-prefixed string for that case rather than failing, and passing that through unchecked
    would let rollback()'s `root / path` resolve, and `_rm_f`, delete outside the repo."""
    root = Path(root)
    cwd = Path(cwd) if cwd is not None else Path(os.getcwd())
    p = Path(str(path))
    absolute = p if p.is_absolute() else (cwd / p)
    absolute = Path(os.path.normpath(str(absolute)))
    rel_path = Path(os.path.relpath(str(absolute), str(root)))
    if rel_path.parts and rel_path.parts[0] == "..":
        raise PathEscapesRootError(f"{path!r} resolves outside repo root {root}: {rel_path}")
    return normalize_path(rel_path.as_posix(), root)


def build_manifest(paths, root, cwd=None) -> list:
    """Build a write-manifest: every entry resolved through to_manifest_path() up front, so the
    manifest rollback() later consumes is already-normalized data, not something re-resolved
    lazily at rollback time."""
    return [to_manifest_path(p, root, cwd) for p in paths]


def _porcelain_paths(output: str) -> list:
    """Extract the reported path from each `git status --porcelain` line. Format is two status
    chars, a space, then the path (`XY path`); a rename is `XY old -> new`, where the live path is
    the new one. Best-effort dequoting for core.quotePath output — sufficient for the plain ascii
    knowledge-base filenames this guard is scoped to; not a general porcelain parser."""
    paths = []
    for line in output.splitlines():
        if not line:
            continue
        rest = line[3:]
        if " -> " in rest:
            rest = rest.split(" -> ", 1)[1]
        paths.append(rest.strip('"'))
    return paths


def expand_pathspec(root, pathspec, *, lease: str | None = None) -> list:
    """`scribe.pathspecs` as git-ready, symlink-normalized directory paths: each glob entry
    (`shared/*/.claude/knowledge`) becomes the paths it matches under `root`, sorted, and
    a glob matching nothing is dropped; a plain entry stays as it is. Handed to git unexpanded,
    such a glob has to match a whole file path, so it matches no file inside the folders and
    `git status` silently reports nothing there, while `git add` refuses it outright. The run's
    snapshots and its commit both take their pathspec from here, so they see the same folders."""
    root = Path(root)
    lib.refresh_lease(root, lease)
    out = []
    for entry in pathspec:
        entry = str(entry)
        matches = ([m.relative_to(root).as_posix() for m in sorted(root.glob(entry))]
                   if any(c in entry for c in "*?[") else [entry])
        for m in matches:
            m = normalize_path(m, root)
            if m not in out:
                out.append(m)
    return out


def snapshot(root, pathspec, run=run_git, *, lease: str | None = None) -> set:
    """git status --porcelain over `pathspec` (directory paths — never a `*.yaml` glob, which
    would silently miss tracked non-yaml files like `epics/*.yaml`), expanded and
    symlink-normalized through expand_pathspec(); every reported path is normalized too.
    `--untracked-files=all` so an entirely-untracked directory is reported file-by-file rather
    than collapsed to one line — collapsing would hide exactly the kind of foreign write this
    guard exists to catch. A pathspec that expands to nothing reports nothing: a bare
    `git status --` would cover the whole repository."""
    root = Path(root)
    lib.refresh_lease(root, lease)
    normalized_spec = expand_pathspec(root, pathspec)
    if not normalized_spec:
        return set()
    code, out, err = run(
        ["status", "--porcelain", "--untracked-files=all", "--", *normalized_spec], root)
    if code != 0:
        raise GitError(f"git status failed (exit {code}): {err.strip()}")
    return {normalize_path(p, root) for p in _porcelain_paths(out)}


def diff(before: set, after: set, manifest, *, root=None, lease: str | None = None) -> set:
    """Paths present in `after` that are not accounted for by `manifest` (this run's explicit
    write-manifest). Non-empty => abort signal.

    Deliberately does NOT subtract `before`: a path already dirty before this run started, and
    still unaccounted for after, is still unaccounted for. Catching pre-existing dirt on its own
    is the precondition check's job (call snapshot() before any writes and treat a non-empty
    result as the cue to abort — see test_case8_*); diff()'s only job is to say whether everything
    present in `after` is explained by the manifest, unconditionally."""
    if root is not None:
        lib.refresh_lease(root, lease)
    manifest_set = set(manifest)
    return {p for p in after if p not in manifest_set}


def exists_at_head(path, root, run=run_git, *, lease: str | None = None) -> bool:
    """Rollback predicate for a single repo-root-relative path, run `git -C root rev-parse
    --verify -q HEAD:<path>` so the predicate and its two rollback actions all agree on what
    `path` means (repo-root-relative, evaluated from repo root).

    True  (git exit 0) -> path exists at HEAD    -> caller should `git checkout -- path`.
    False (git exit 1) -> path does not exist at HEAD -> caller should `rm -f path`.
    Anything else (e.g. 128, cwd outside any git work tree) is a hard error: raises GitError, and
    must NEVER be treated as license to `rm -f`.
    """
    lib.refresh_lease(root, lease)
    code, out, err = run(["rev-parse", "--verify", "-q", f"HEAD:{path}"], root)
    if code == 0:
        return True
    if code == 1:
        return False
    raise GitError(f"git rev-parse --verify -q HEAD:{path} exited {code}: {err.strip()}")


class RollbackOutcome(NamedTuple):
    path: str
    action: str          # "checkout" | "rm" | "error"
    ok: bool
    detail: str = ""


def _rm_f(full_path: Path) -> None:
    """rm -f semantics: unconditional removal, no error if the file is already gone."""
    try:
        full_path.unlink()
    except FileNotFoundError:
        pass


def rollback(manifest, root, run=run_git, *, lease: str | None = None) -> list:
    """Roll back every path in `manifest` (repo-root-relative, already symlink-normalized —
    e.g. via build_manifest()).

    Processes ALL paths even when one fails: never short-circuits, and never batches the
    checkouts into a single `git checkout -- <paths...>` call, because a batch containing even one
    untracked entry exits nonzero as a whole even when every tracked entry in it would have
    succeeded — relying on that one exit code to decide whether rollback "ran" would silently skip
    every other path in the batch.

    The predicate is re-evaluated FRESH for every path, at the moment this function actually runs
    — never reused from whatever it evaluated to when the path was first queued into the
    manifest. HEAD can move between queueing and rollback (a second process/scribe can land the
    same path first), and a cached predicate result is exactly the bug class this design was
    revised twice to kill.
    """
    root = Path(root)
    lib.refresh_lease(root, lease)
    outcomes = []
    for path in manifest:
        try:
            at_head = exists_at_head(path, root, run=run)
        except GitError as e:
            outcomes.append(RollbackOutcome(path, "error", False, str(e)))
            continue
        if at_head:
            code, out, err = run(["checkout", "--", path], root)
            outcomes.append(RollbackOutcome(path, "checkout", code == 0, err.strip()))
            continue
        try:
            _rm_f(root / path)
            outcomes.append(RollbackOutcome(path, "rm", True))
        except OSError as e:
            outcomes.append(RollbackOutcome(path, "error", False, str(e)))
    return outcomes
