"""Knowledge-base core: load registries, match applies_to, resolve overrides."""
from __future__ import annotations

import copy
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

try:
    import yaml
except ImportError:  # no system PyYAML: fall back to the copy shipped in scripts/vendor/
    sys.path.append(str(Path(__file__).resolve().parent / "vendor"))
    import yaml


@dataclass
class Rule:
    fqid: str
    scope: str
    topic: str
    id: str
    title: str
    applies_to: dict = field(default_factory=dict)
    severity: str = "recommended"
    override_policy: str = "overridable"
    digest_only: bool = False
    resident: bool = False
    sweep_only: bool = False
    no_jit: bool = False
    trigger: str = ""
    rule: str = ""
    check: dict | None = None
    rationale: str = ""
    source: str = ""
    overrides: list = field(default_factory=list)
    conflicts_with: list = field(default_factory=list)
    see_also: list = field(default_factory=list)


def _aslist(v):
    if v is None:
        return []
    return list(v) if isinstance(v, list) else [v]


_YAML_LOADER = getattr(yaml, "CSafeLoader", yaml.SafeLoader)  # libyaml when available,
# falls back to the pure-Python SafeLoader on a build without it (e.g. no libyaml).


def load_registry(path: Path) -> list:
    data = yaml.load(path.read_text(), Loader=_YAML_LOADER) or {}
    scope, topic = data.get("scope"), data.get("topic")
    out = []
    for r in data.get("rules", []) or []:
        out.append(Rule(
            fqid=f"{scope}/{topic}#{r['id']}",
            scope=scope, topic=topic, id=r["id"], title=r["title"],
            applies_to=r.get("applies_to") or {},
            severity=r.get("severity", "recommended"),
            override_policy=r.get("override_policy", "overridable"),
            digest_only=r.get("digest_only", False),
            resident=r.get("resident", False),
            sweep_only=r.get("sweep_only", False),
            no_jit=r.get("no_jit", False),
            trigger=r.get("trigger", ""),
            rule=r.get("rule", ""),
            check=r.get("check"),
            rationale=r.get("rationale", ""),
            source=r.get("source", ""),
            overrides=_aslist(r.get("overrides")),
            conflicts_with=_aslist(r.get("conflicts_with")),
            see_also=_aslist(r.get("see_also")),
        ))
    return out


def load_all(roots: list) -> list:
    rules = []
    for root in roots:
        kdir = Path(root) / ".claude" / "knowledge"
        if not kdir.is_dir():
            continue
        for path in sorted(kdir.rglob("*.yaml")):
            rules.extend(load_registry(path))
    return rules


DEFAULT_TRAILER = "Full rule bodies live in .claude/knowledge/*.yaml; look a rule up there by its id.\n"

CONFIG_DEFAULTS = {
    "root_scope": "project",
    "extra_scopes": [],
    "registry_fallbacks": [],
    "unprobed_scopes": [],
    "probe_roots": [],
    "gate_marker": "knowledge pre-commit gate",
    "digest_trailer": DEFAULT_TRAILER,
    "digest_guard": None,
    "scribe": {"commit": "commit", "pathspecs": [".claude/knowledge"],
               "path_translations": [], "audit_every_days": 7, "lease_minutes": 60,
               "capture": "off"},
}

CONFIG_REL = Path(".claude") / "knowledge" / "config.yaml"


def _is_str_list(v) -> bool:
    return isinstance(v, list) and all(isinstance(x, str) for x in v)


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _is_dict_list(keys):
    return lambda v: isinstance(v, list) and all(
        isinstance(x, dict) and all(isinstance(x.get(k), str) for k in keys) for x in v)


def _is_digest_guard(v) -> bool:
    """`{resident: N, max_bytes: M}`, either key optional: the numbers the knowledge-route
    digest guard (test_build_digest.py) pins for this project. Absent means no guard."""
    limits = {"resident": lambda n: _is_int(n) and n >= 0, "max_bytes": lambda n: _is_int(n) and n > 0}
    return (isinstance(v, dict) and bool(v)
            and all(k in limits and limits[k](n) for k, n in v.items()))


_VALID = {
    "root_scope": lambda v: isinstance(v, str) and bool(v),
    "extra_scopes": _is_str_list,
    "registry_fallbacks": _is_str_list,
    "unprobed_scopes": _is_str_list,
    "probe_roots": _is_dict_list(("registry", "tree")),
    "gate_marker": lambda v: isinstance(v, str) and bool(v),
    "digest_trailer": lambda v: isinstance(v, str),
    "digest_guard": _is_digest_guard,
}
_VALID_SCRIBE = {
    "commit": lambda v: v in ("commit", "stage"),
    "pathspecs": _is_str_list,
    "path_translations": _is_dict_list(("from", "to")),
    "audit_every_days": lambda v: _is_int(v) and v >= 0,
    "lease_minutes": lambda v: _is_int(v) and v > 0,
    "capture": lambda v: v in ("off", "auto", "handoff", "transcript"),
}

_config_warned = False


def _warn_config(root: Path, problems: list) -> None:
    """One stderr line per process, however many configs or problems there are."""
    global _config_warned
    if _config_warned or not problems:
        return
    _config_warned = True
    print(f"knowledge: {root / CONFIG_REL}: {'; '.join(problems)}; using defaults for those",
          file=sys.stderr)


def load_config(root: Path) -> dict:
    """`.claude/knowledge/config.yaml` deep-merged over CONFIG_DEFAULTS. An absent or empty
    file gives the defaults silently. A file that does not parse, an unknown key, or a value
    of the wrong type falls back to the default for that key and costs one stderr line per
    process."""
    config = copy.deepcopy(CONFIG_DEFAULTS)
    path = Path(root) / CONFIG_REL
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return config
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError:
        _warn_config(root, ["malformed YAML"])
        return config
    if data is None:
        return config
    if not isinstance(data, dict):
        _warn_config(root, ["top level is not a mapping"])
        return config
    problems = []
    for key, value in data.items():
        if key == "scribe":
            if not isinstance(value, dict):
                problems.append("scribe is not a mapping")
                continue
            for k, v in value.items():
                if k not in _VALID_SCRIBE:
                    problems.append(f"unknown key scribe.{k}")
                elif _VALID_SCRIBE[k](v):
                    config["scribe"][k] = v
                else:
                    problems.append(f"bad value for scribe.{k}")
        elif key not in _VALID:
            problems.append(f"unknown key {key}")
        elif _VALID[key](value):
            config[key] = value
        else:
            problems.append(f"bad value for {key}")
    _warn_config(root, problems)
    return config


def _has_kb(path: Path) -> bool:
    return (path / ".claude" / "knowledge").is_dir()


def scope_roots(root, config: dict | None = None) -> list:
    """Every scope root that carries a .claude/knowledge directory, root scope first.

    Top-level directories with their own registry are always scopes. `extra_scopes` globs
    (relative to the root) add the ones that live deeper, such as a registry kept under a
    tracked umbrella directory for a clone that has no top-level home."""
    root = Path(root)
    config = config if config is not None else load_config(root)
    roots = [root]
    for child in sorted(root.iterdir()):
        if _has_kb(child):
            roots.append(child)
    for pattern in config["extra_scopes"]:
        for match in sorted(root.glob(pattern)):
            if match.is_dir() and _has_kb(match) and match not in roots:
                roots.append(match)
    return roots


def service_of(root, path, config: dict | None = None) -> str | None:
    """Name of the deepest scope root containing `path` (absolute, or relative to `root`);
    None for a path that only the root scope covers."""
    root = Path(root)
    target = Path(path)
    if not target.is_absolute():
        target = root / target
    best = None
    for scope in scope_roots(root, config)[1:]:
        if target == scope or scope in target.parents:
            if best is None or len(scope.parts) > len(best.parts):
                best = scope
    return best.name if best else None


def registry_root(root, service: str, config: dict | None = None) -> Path | None:
    """Where a service's rule registry lives: `<root>/<service>`, else the first
    `registry_fallbacks` template that holds a registry, else None. `{service}` is
    substituted with str.replace, so any other brace in a template stays literal."""
    root = Path(root)
    config = config if config is not None else load_config(root)
    direct = root / service
    if _has_kb(direct):
        return direct
    for template in config["registry_fallbacks"]:
        candidate = root / template.replace("{service}", service)
        if _has_kb(candidate):
            return candidate
    return None


def _glob_to_regex(pattern: str) -> str:
    """Translate a path glob to a regex. `**` matches any number of path segments
    (including zero); `*` matches within one segment; `?` matches one non-slash char.
    stdlib fnmatch can't do `**` and lets `*` cross `/`, so we roll our own."""
    i, n, out = 0, len(pattern), []
    while i < n:
        c = pattern[i]
        if c == "*":
            if pattern[i:i + 2] == "**":
                i += 2
                if pattern[i:i + 1] == "/":
                    i += 1
                    out.append("(?:.*/)?")   # zero or more leading segments
                else:
                    out.append(".*")
                continue
            out.append("[^/]*")
            i += 1
        elif c == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(c))
            i += 1
    return "".join(out)


def glob_match(pattern: str, path: str) -> bool:
    return re.fullmatch(_glob_to_regex(pattern), path) is not None


def file_matches(rule: Rule, rel_path: str, service, include_sweep_only: bool = False) -> bool:
    if rule.digest_only:
        return False                 # awareness-only: in the digest, never a per-file reminder
    if rule.sweep_only and not include_sweep_only:
        return False                 # judgment-only, broad-glob rule: review-sweep reads it, not every check.py caller.
                                     # Reminder channel only — inject-rules-on-edit.py passes include_sweep_only=True so
                                     # the rule's body still reaches the edit; `no_jit` is that channel's own opt-out.
    at = rule.applies_to or {}
    services = at.get("services")
    globs = at.get("globs")
    if services and service is not None and service not in services:
        return False
    # `service is None` is the workspace path space -- a file outside every service -- so the
    # services filter above cannot discriminate there and the globs are the only filter left.
    # A root-scope rule reaching root files through a workspace-relative glob is normal and must
    # keep working (`.claude/scenarios/**`, `services.manifest`); a rule with services and NO
    # globs has nothing left to filter on and would match every file in the workspace.
    if services and service is None and not globs:
        return False
    if globs and not any(glob_match(g, rel_path) for g in globs):
        return False
    return True


def resolve_overrides(rules: list, service):
    """Return (effective_rules, conflicts). Pass rules already scoped to {root scope + service}."""
    by_fqid = {r.fqid: r for r in rules}
    suppressed, conflicts = set(), []
    for r in rules:
        for target in r.overrides:
            tgt = by_fqid.get(target)
            if tgt is None:
                conflicts.append(("dangling_override", r.fqid, target))
                continue
            if tgt.override_policy == "binding":
                conflicts.append(("override_of_binding", r.fqid, target))
                continue
            suppressed.add(target)
    effective = [r for r in rules if r.fqid not in suppressed]
    return effective, conflicts


def add_lease_arg(parser) -> None:
    """The `--lease RUN_ID` flag every script `/knowledge:kb run` calls accepts."""
    parser.add_argument("--lease", default=None, metavar="RUN_ID",
                        help="run id of the /kb run holding the scribe lease; refreshes it")


def refresh_lease(root, run_id) -> None:
    """Refresh the run lease `run_id`. Never raises: a mismatched id costs one stderr line,
    any other trouble (no lease file, corrupt file, unwritable local dir) nothing."""
    if not run_id:
        return
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent / "kb"))
        import kb_lease
        if not kb_lease.refresh(Path(root), run_id):
            print(f"knowledge: lease {run_id} is not the current lease; not refreshed",
                  file=sys.stderr)
    except Exception:
        pass


def touch_lease(root, args) -> None:
    """Refresh the lease named by `args.lease`; a silent no-op without the flag. Never fails
    the calling script (see refresh_lease)."""
    refresh_lease(root, getattr(args, "lease", None))
