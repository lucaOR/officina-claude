#!/usr/bin/env python3
"""Knowledge-base graph linter. A disk-scan over the whole tree (decoupled from
what is loaded into context): referential integrity, illegal/duplicate overrides,
conflict-candidate clusters, and override fan-out / zombie defaults."""
from __future__ import annotations

import argparse
import functools
import importlib.util
import json
import os
import sys
from itertools import combinations
from pathlib import Path

import build_digest
import lib
import paths


def _all_edges(r: lib.Rule):
    for t in r.overrides:
        yield t
    for t in r.conflicts_with:
        yield t
    for t in r.see_also:
        yield t


def check_edges(rules: list) -> list:
    """Mechanical referential integrity. Returns list of (kind, subject, target)."""
    errors, seen = [], {}
    for r in rules:
        if r.fqid in seen:
            errors.append(("duplicate_fqid", r.fqid, ""))
        else:
            seen[r.fqid] = r   # first occurrence wins; keeps edge lookups deterministic under a duplicate
    for r in rules:
        for target in _all_edges(r):
            if target not in seen:
                errors.append(("dangling_edge", r.fqid, target))
        for target in r.overrides:
            tgt = seen.get(target)
            if tgt is not None and tgt.override_policy == "binding":
                errors.append(("override_of_binding", r.fqid, target))
    by_scope_target: dict = {}
    for r in rules:
        for target in r.overrides:
            by_scope_target.setdefault((r.scope, target), []).append(r.fqid)
    for (_scope, target), fqids in sorted(by_scope_target.items()):
        if len(fqids) > 1:
            errors.append(("double_override_same_scope", ",".join(sorted(fqids)), target))
    return errors


def _services(r: lib.Rule) -> set:
    return set((r.applies_to or {}).get("services") or [])


def _services_overlap(a: lib.Rule, b: lib.Rule) -> bool:
    sa, sb = _services(a), _services(b)
    if not sa or not sb:          # an unrestricted rule overlaps everything in its topic
        return True
    return bool(sa & sb)


def _linked(a: lib.Rule, b: lib.Rule) -> bool:
    return b.fqid in set(_all_edges(a)) or a.fqid in set(_all_edges(b))


def candidate_clusters(rules: list, focus: str | None = None) -> list:
    """Same-topic, service-overlapping rule groups that contain at least one
    undeclared (unlinked) pair. Returns a list of clusters (each a sorted FQID list)."""
    by_topic: dict = {}
    for r in rules:
        by_topic.setdefault(r.topic, []).append(r)
    clusters = []
    for _topic, group in sorted(by_topic.items()):
        parent = {r.fqid: r.fqid for r in group}

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        for a, b in combinations(group, 2):
            if _services_overlap(a, b):
                parent[find(a.fqid)] = find(b.fqid)
        comps: dict = {}
        for r in group:
            comps.setdefault(find(r.fqid), []).append(r)
        for members in comps.values():
            if len(members) < 2:
                continue
            has_undeclared = any(_services_overlap(a, b) and not _linked(a, b)
                                 for a, b in combinations(members, 2))
            if not has_undeclared:
                continue
            fqids = sorted(m.fqid for m in members)
            if focus and focus not in fqids:
                continue
            clusters.append(fqids)
    return clusters


def fan_out(rules: list, focus: str | None = None, config: dict | None = None) -> list:
    """For each root-scope rule with explicit services, report which of those services
    override it. Returns (fqid, [overriding_services], status) with status in
    {none, healthy, zombie_default}."""
    root_scope = (config or lib.CONFIG_DEFAULTS)["root_scope"]
    out = []
    for r in rules:
        if r.scope != root_scope:
            continue
        services = _services(r)
        if not services:
            continue   # no service list -> nothing to fan out against (unlike candidate_clusters, where no-services overlaps all)
        if focus and r.fqid != focus:
            continue
        overriding = {o.scope for o in rules if o.scope in services and r.fqid in o.overrides}
        if not overriding:
            status = "none"
        elif overriding >= services:
            status = "zombie_default"
        else:
            status = "healthy"
        out.append((r.fqid, sorted(overriding), status))
    return out


def _tiered_scopes(rules: list) -> set:
    """Scopes whose digest renders two-tier. build_digest.render() switches on the data,
    `any(r.resident for r in rules)`, per scope root — so a scope with no resident rule
    still prints every rule in full and nothing in it is collapsed. Without this gate both
    advisories below fire on rules that carry a full line in their own service digest."""
    scopes = {r.scope for r in rules}
    return {s for s in scopes if any(r.resident for r in rules if r.scope == s)}


def id_only_rules(rules: list) -> list:
    """Rules the model only ever sees as a bare id: collapsed in a tiered scope's digest,
    unreachable by the on-edit injector (`digest_only`, which is excluded from per-file
    matching altogether, or `no_jit`, which opts out of the injection channel specifically),
    and with no mechanical check behind them.

    Advisory, not an error. The id is still printed on the digest's `also:` line and the
    body is one `query.py knowledge <id>` away, so the rule is discoverable — it just has
    to carry its whole meaning in its id.

    The epics topic is excluded: render() drops it from a tiered digest entirely and
    leaves it to the digest trailer, so those rules are reached by a documented path rather than
    by their id."""
    tiered = _tiered_scopes(rules)
    return sorted(r.fqid for r in rules
                  if r.scope in tiered and r.topic != "epics"
                  and (r.digest_only or r.no_jit) and not r.resident and not r.check)


_HOOK = Path(__file__).resolve().parent.parent / "hooks" / "inject-rules-on-edit.py"


def _hook_module():
    """The on-edit injector, loaded by path because its filename is not importable.
    Returns None if it cannot be loaded: the oversize advisory is optional signal and
    must never break a validate run."""
    try:
        spec = importlib.util.spec_from_file_location("inject_rules_on_edit", _HOOK)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    except Exception:
        return None


def oversize_jit_rules(rules: list) -> list:
    """Collapsed rules the on-edit injector can never deliver: JIT-eligible (not
    digest_only, not resident, and in a scope whose digest actually tiers, so the digest
    carries only their id) but rendering larger than the hook's per-file byte cap. pick()
    skips an over-budget rule with `continue`, so such a rule is absent from every
    injection whatever file is edited.

    Advisory, not an error: the id is still on the digest's `also:` line and the body
    is one `query.py knowledge <id>` away. Returns (fqid, bytes), largest first."""
    hook = _hook_module()
    if hook is None:
        return []
    tiered = _tiered_scopes(rules)
    cap = hook.file_budget()
    sized = [(r.fqid, len(hook.body(r).encode("utf-8"))) for r in rules
             if r.scope in tiered and not r.digest_only and not r.resident]
    return sorted([(f, n) for f, n in sized if n > cap], key=lambda x: (-x[1], x[0]))


# Build output and dependency trees dwarf the source and can never be a rule's target.
_PRUNE = {".git", "node_modules", "vendor", "dist", "build", "coverage", "__pycache__",
          ".yarn", ".angular", ".gradle", ".venv", ".pytest_cache", "storage"}


@functools.lru_cache(maxsize=None)
def _tree(root: Path) -> tuple:
    """Root-relative paths of every file under root, pruning heavy build/dependency dirs.
    A filesystem walk rather than `git ls-files` on purpose: rules legitimately target
    gitignored paths (`*/.env`) and submodule-internal ones (`**/.devcontainer/**`), and
    git would list neither, which would report a working rule as unreachable.

    Memoized: the root scope's probe space re-walks every service tree, so without this the
    same trees are walked once per scope."""
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _PRUNE]
        rel = Path(dirpath).relative_to(root)
        out += [str(rel / f) if str(rel) != "." else f for f in filenames]
    return tuple(out)


def _probe_spaces(rules: list, roots: list, config: dict | None = None) -> dict:
    """Per scope, the (paths, service) pairs a rule in it could be matched against.

    A rule is evaluated against whatever path shape check.py was invoked with, and that
    differs by invocation: check-on-edit's resolve() yields service-relative paths for a
    file inside a submodule and workspace-relative ones for everything else. A root-scope
    rule therefore has to be probed against both, or a glob like `.claude/scenarios/**`
    reads as unreachable merely because no submodule has a `.claude/scenarios/`.

    A scope whose registry matches a `probe_roots` entry keeps its registry in one place
    but writes its globs against a checkout elsewhere (the entry's `tree`, with `{name}`
    the registry directory's name). That checkout is where it is probed. It may be
    per-developer; when it is absent the space is None, meaning reachability cannot be
    decided here."""
    config = config or lib.CONFIG_DEFAULTS
    paths = [Path(r) for r in roots]
    workspace = paths[0]                       # scope_roots() documents root scope first
    services = {p.name: p for p in paths[1:] if (p / ".claude").is_dir()
                and p.parent == workspace}     # excludes scopes registered deeper
    probed = {}
    for p in paths[1:]:
        rel = p.relative_to(workspace).as_posix() if workspace in p.parents else None
        for entry in config["probe_roots"]:
            if rel is not None and lib.glob_match(entry["registry"], rel):
                probed[p.name] = workspace / entry["tree"].replace("{name}", p.name)
                break
    spaces: dict = {}
    for scope in {r.scope for r in rules}:
        if scope in probed:
            tree = probed[scope]
            spaces[scope] = [(_tree(tree), scope)] if tree.is_dir() else None
            continue
        if scope in services:
            spaces[scope] = [(_tree(services[scope]), scope)]
            continue
        # root scope: reachable via a service-relative path OR a workspace-relative one
        spaces[scope] = [(_tree(p), name) for name, p in sorted(services.items())] \
            + [(_tree(workspace), None)]
    return spaces


def unreachable_globs(rules: list, roots: list, config: dict | None = None) -> list:
    """Rules whose `globs` match no file that exists, in any path space they can be
    evaluated in — so the rule can never fire, whatever you edit.

    This is the failure the hit-ledger cannot diagnose: a never-fired rule looks identical
    whether its globs are wrong or you simply have not worked in that area yet, and no
    amount of accumulated history separates the two. Reachability is static, so it is
    answered here instead, at authoring time.

    Three exemptions, each a rule that reaches the model by a path this probe does not
    model: rules with no globs match every file; digest_only rules are excluded from
    per-file matching by design (lib.file_matches short-circuits them); and the scopes
    named in the config's `unprobed_scopes` reach the model some other way, so their globs
    are written against a tree this probe cannot see. A probed scope whose checkout is not
    present locally is skipped too, since there is no tree to probe (see _probe_spaces).
    Returns (fqid, globs), sorted."""
    config = config or lib.CONFIG_DEFAULTS
    unprobed = set(config["unprobed_scopes"])
    spaces = _probe_spaces(rules, roots, config)
    out = []
    for r in rules:
        globs = (r.applies_to or {}).get("globs")
        if not globs or r.digest_only or r.scope in unprobed:
            continue
        if spaces.get(r.scope, []) is None:
            continue
        reachable = any(lib.file_matches(r, path, service, include_sweep_only=True)
                        for paths, service in spaces.get(r.scope, [])
                        for path in paths)
        if not reachable:
            out.append((r.fqid, globs))
    return sorted(out)


def muted_checks(rules: list) -> list:
    """Rules whose executable check can never run because a muting flag hides them from
    the matcher.

    check.evaluate() builds its matched list through lib.file_matches(r, f, service,
    include_sweep_only) BEFORE it reaches the `if not r.check` branch, so a `sweep_only`
    rule with a check evaluates only when a sweep caller passes --include-sweep-only —
    never from check-on-edit.py and never from the pre-commit gate. The readiness sweep
    is that lone caller, so such a rule can only ever emit sweep-phase rows, and every
    instance it produces classifies as landed_ungated forever. `digest_only` is worse:
    file_matches() returns False for it unconditionally, so the check is dead in every
    channel.

    Either way the rule looks healthy — it is in the registry, it has a check, the
    engine reports no violations for it — while enforcing nothing. That is why this is
    an error and not a warning."""
    out = []
    for r in rules:
        if not r.check:
            continue
        if r.sweep_only:
            out.append((r.fqid, "sweep_only"))
        if r.digest_only:
            out.append((r.fqid, "digest_only"))
    return sorted(out)


def _same_dir(a, b) -> bool:
    a, b = Path(a), Path(b)
    return os.path.abspath(a) == os.path.abspath(b) or a.resolve() == b.resolve()


def _shown(path: Path, project: Path) -> str:
    try:
        return Path(os.path.abspath(path)).relative_to(os.path.abspath(project)).as_posix()
    except ValueError:
        return str(path)


def scope_mismatches(roots: list, project, config: dict | None = None) -> list:
    """Registries whose declared `scope:` is not the scope of the root they live under: the
    config's `root_scope` for the project root (its `epics/` included), the scope directory's
    own name for every other scope root (a service, or an `extra_scopes` match in a
    nested directory). This is the invariant the edit hook's matching() relies on: it keeps only
    rules whose scope is `root_scope` or the edited file's service, which is the name of the
    deepest scope root holding the file, so a rule in a mis-scoped registry still validates
    and renders but is never injected. A file with neither a `scope:` nor any rules (such as
    config.yaml) is not a registry. Returns (registry path shown relative to the project,
    declared scope, expected scope, FQIDs of its rules), sorted by path."""
    config = config or lib.CONFIG_DEFAULTS
    out = []
    for root in roots:
        expected = config["root_scope"] if _same_dir(root, project) \
            else Path(os.path.abspath(root)).name
        kdir = Path(root) / ".claude" / "knowledge"
        if not kdir.is_dir():
            continue
        for path in sorted(kdir.rglob("*.yaml")):
            data = lib.yaml.load(path.read_text(), Loader=lib._YAML_LOADER)
            if not isinstance(data, dict):
                continue
            declared, rules = data.get("scope"), data.get("rules") or []
            if declared == expected or (declared is None and not rules):
                continue
            fqids = [f"{declared}/{data.get('topic')}#{r.get('id')}"
                     for r in rules if isinstance(r, dict)]
            out.append((_shown(path, project), declared, expected, fqids))
    return sorted(out, key=lambda m: m[0])


def scope_mismatch_text(path: str, declared, expected: str) -> str:
    return (f"ERROR scope_mismatch: {path} declares scope {declared}, but a registry under its "
            f"scope root must declare {expected}; the edit hook never injects its rules.")


def validate(rules: list, focus: str | None = None, roots: list | None = None,
             config: dict | None = None) -> dict:
    return {
        "errors": check_edges(rules) + [("muted_check", fqid, flag)
                                        for fqid, flag in muted_checks(rules)],
        "candidates": candidate_clusters(rules, focus),
        "fan_out": [f for f in fan_out(rules, focus, config) if f[2] != "none"],
        "id_only": id_only_rules(rules),
        "oversize_jit": oversize_jit_rules(rules),
        "unreachable_globs": unreachable_globs(rules, roots, config) if roots else [],
    }


def _default_roots(root=None, config: dict | None = None) -> list:
    return lib.scope_roots(paths.project_root(root), config)


def digest_drift(roots: list, config: dict | None = None) -> list:
    """Scope roots whose committed _digest.md differs from a fresh render (out of sync)."""
    out = []
    for root in roots:
        digest = Path(root) / ".claude" / "knowledge" / "_digest.md"
        if not digest.exists():
            continue
        if digest.read_text() != build_digest.render(lib.load_all([root]), config):
            out.append(str(digest))
    return out


def findings(report: dict, oversize: bool = False) -> list:
    """The findings main() prints, as `{"category", "fqids", "text"}` dicts, in print order.
    `text` is the exact line the text output prints; `category` is its leading token. Unlike
    the text output, candidate clusters are always included, because the health sweep wants
    them without a --focus. Kept beside main()'s print loops: test_json_flag_leaves_text_output
    _unchanged checks that every line here also appears in the text output."""
    out = []

    def add(category, fqids, text):
        out.append({"category": category, "fqids": list(fqids), "text": text})

    for kind, subject, target in report["errors"]:
        add("ERROR", subject.split(","),
            f"ERROR {kind}: {subject}" + (f" -> {target}" if target else ""))
    for path, declared, expected, fqids in report.get("scope_mismatch", []):
        add("ERROR", fqids, scope_mismatch_text(path, declared, expected))
    for cluster in report["candidates"]:
        add("CANDIDATE", cluster,
            "CANDIDATE (same topic, overlapping, undeclared): " + ", ".join(cluster))
    for fqid, services, status in report["fan_out"]:
        add("FAN-OUT", [fqid], f"FAN-OUT [{status}] {fqid}: overridden by {', '.join(services)}")
    for fqid, globs in report["unreachable_globs"]:
        add("ERROR", [fqid],
            f"ERROR unreachable_glob: {fqid} — globs match no existing file "
            f"({', '.join(globs)}); the rule can never fire. Fix the pattern, or drop "
            f"the rule if what it guarded is gone.")
    for fqid in report["id_only"]:
        add("WARN", [fqid],
            f"WARN id_only_rule: {fqid} — seen by id only (no gist in the digest, no "
            f"JIT injection, no check). Confirm the id is self-describing, or set "
            f"resident: true.")
    if report["oversize_jit"]:
        worst_fqid, worst_bytes = report["oversize_jit"][0]
        add("WARN", [f for f, _ in report["oversize_jit"]],
            f"WARN oversize_jit_rules: {len(report['oversize_jit'])} collapsed rules "
            f"render larger than the on-edit hook's per-file cap and can never be "
            f"injected (largest: {worst_fqid} at {worst_bytes} B). "
            f"Re-run with --oversize to list them.")
    if oversize:
        for fqid, n in report["oversize_jit"]:
            add("OVERSIZE", [fqid], f"OVERSIZE {n} B {fqid}")
    for path in report["digest_drift"]:
        add("ERROR", [],
            f"ERROR digest_out_of_sync: {path} (rebuild with build_digest.py for that scope)")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--focus", default=None, help="restrict candidates/fan-out to this FQID; candidate clusters print ONLY when focused")
    ap.add_argument("--oversize", action="store_true",
                    help="list every collapsed rule too large for the on-edit hook's per-file cap")
    ap.add_argument("--json", action="store_true",
                    help="print the findings as a JSON list of {category, fqids, text} instead "
                         "of text (candidate clusters included); the exit status is unchanged")
    ap.add_argument("roots", nargs="*", help="scope roots to scan; default = every scope under the project root")
    ap.add_argument("--root", default=None, help="project root (default: resolved from $CLAUDE_PROJECT_DIR or the cwd)")
    lib.add_lease_arg(ap)
    a = ap.parse_args()
    root = paths.project_root(a.root)
    if paths.skip_without_knowledge(root, "validate"):
        return
    lib.touch_lease(root, a)
    config = lib.load_config(root)
    roots = [Path(x) for x in a.roots] or _default_roots(root, config)
    report = validate(lib.load_all(roots), a.focus, roots, config)
    report["digest_drift"] = digest_drift(roots, config)
    report["scope_mismatch"] = scope_mismatches(roots, root, config)
    failing = bool(report["errors"] or report["digest_drift"] or report["unreachable_globs"]
                   or report["scope_mismatch"])
    if a.json:
        print(json.dumps(findings(report, a.oversize), indent=2))
        sys.exit(1 if failing else 0)

    for kind, subject, target in report["errors"]:
        print(f"ERROR {kind}: {subject}" + (f" -> {target}" if target else ""))
    for path, declared, expected, _fqids in report["scope_mismatch"]:
        print(scope_mismatch_text(path, declared, expected))
    # Candidate clusters are a write-time signal for knowledge-route: on a full run
    # they are 28 lines of advisory wallpaper nobody acts on, so print them only when
    # --focus scopes them to the rule being added/edited.
    if a.focus:
        for cluster in report["candidates"]:
            print("CANDIDATE (same topic, overlapping, undeclared): " + ", ".join(cluster))
    for fqid, services, status in report["fan_out"]:
        print(f"FAN-OUT [{status}] {fqid}: overridden by {', '.join(services)}")
    for fqid, globs in report["unreachable_globs"]:
        print(f"ERROR unreachable_glob: {fqid} — globs match no existing file "
              f"({', '.join(globs)}); the rule can never fire. Fix the pattern, or drop "
              f"the rule if what it guarded is gone.")
    for fqid in report["id_only"]:
        print(f"WARN id_only_rule: {fqid} — seen by id only (no gist in the digest, no "
              f"JIT injection, no check). Confirm the id is self-describing, or set "
              f"resident: true.")
    if report["oversize_jit"]:
        worst_fqid, worst_bytes = report["oversize_jit"][0]
        print(f"WARN oversize_jit_rules: {len(report['oversize_jit'])} collapsed rules "
              f"render larger than the on-edit hook's per-file cap and can never be "
              f"injected (largest: {worst_fqid} at {worst_bytes} B). "
              f"Re-run with --oversize to list them.")
    if a.oversize:
        for fqid, n in report["oversize_jit"]:
            print(f"OVERSIZE {n} B {fqid}")
    for path in report["digest_drift"]:
        print(f"ERROR digest_out_of_sync: {path} (rebuild with build_digest.py for that scope)")
    printed = report["errors"] or report["fan_out"] or report["digest_drift"] \
        or report["id_only"] or report["oversize_jit"] or report["unreachable_globs"] \
        or report["scope_mismatch"] or (a.focus and report["candidates"])
    if not printed:
        print("Knowledge base clean: no errors, fan-out, or digest drift.")
    sys.exit(1 if failing else 0)


if __name__ == "__main__":
    main()
