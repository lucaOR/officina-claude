#!/usr/bin/env python3
"""PreToolUse(Edit|Write|MultiEdit): re-inject the full body of any collapsed knowledge
rule that applies to the file about to be written.

Why: once build_digest.render() tiers a scope (see matching() below), the digest keeps
only blocking and binding rules of that scope in full text and collapses the rest to bare
ids, which cuts about 12 KB off every session's cached prefix. That prefix is replayed on
every API response, so a rule that is needed once in a session should be paid for once in
that session rather than once per response. This hook is the recovery path — a collapsed
rule comes back in full the first time the agent is about to touch a file the rule applies
to.

Injected once per (session, rule): within a session nothing leaves the context, so a second
injection of the same rule is pure replay cost carrying no new information.

Safety properties:
  * Resident rules never inject — they are already in the digest in full.
  * Rules in a scope with no resident rule never inject either — that scope was never
    tiered by build_digest.render(), so nothing in it is collapsed and there is nothing to
    recover. Before any rule anywhere is resident, this hook injects nothing at all; that
    is the correct, inert state.
  * digest_only rules never inject — lib.file_matches() returns False for them, so the JIT
    path can never reach them. This is independent of residency: a digest_only rule can be
    non-resident (an awareness-only rule with no natural per-file home) and still never
    qualify for JIT recovery. That gap is covered separately, by a WARN id_only_rule check
    on rules that are digest_only without being resident.
  * sweep_only rules DO inject — see matching(). That field defers a rule's per-commit
    reminder line to the review sweep; it says nothing about whether the rule's body helps
    while the code is being written. The opt-out for this channel is no_jit.
  * no_jit rules never inject, whatever their other flags — for a rule that can only be
    applied while reviewing finished text, not while producing it.
  * A hard ceiling of DEFAULT_BUDGET bytes of rule text per session, and a separate,
    smaller DEFAULT_FILE_BUDGET bytes per single file, bounds the worst case both across a
    session and on the very first file touched.
  * The session state file is read, decided over, and written back while holding an exclusive
    lock (filelock.exclusive) on a sibling .lock file. Acquisition is non-blocking and retried against a
    RULE_INJECT_LOCK_WAIT-second deadline (default DEFAULT_LOCK_WAIT): a wedged or
    SIGSTOPed lock holder must never make this hook hang an edit. On timeout the injection
    is skipped, never performed unlocked — skipping is always safe, proceeding unlocked
    would reopen the exact race the lock exists to close.
  * The lock is only ever taken once a file has at least one candidate rule. An edit whose
    file matches nothing — including the fully inert, pre-Task-6 state of the whole
    repository, where no scope is tiered yet — never creates any file under the cache
    directory.
  * Fail-open: any error here allows the tool call to proceed with no injection.

Disable entirely with RULE_INJECT_DISABLE=1. Tune the session ceiling with RULE_INJECT_BYTES,
the per-file ceiling with RULE_INJECT_FILE_BYTES, and the lock-wait deadline with
RULE_INJECT_LOCK_WAIT.
"""
import contextlib
import io
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import filelock  # noqa: E402  (needs the sys.path line above)
import lib  # noqa: E402
import paths  # noqa: E402
import usage  # noqa: E402

CACHE = (Path(os.environ.get("XDG_CACHE_HOME") or (Path.home() / ".cache"))
         / "claude-code-hooks" / "rules")
DEFAULT_BUDGET = 12288             # bytes of injected rule text per session
DEFAULT_FILE_BUDGET = 3072         # bytes of injected rule text per single file
DEFAULT_LOCK_WAIT = 2.0            # seconds to retry a contended lock before giving up


def budget():
    try:
        value = int(os.environ.get("RULE_INJECT_BYTES") or DEFAULT_BUDGET)
    except ValueError:
        return DEFAULT_BUDGET
    return value if value > 0 else DEFAULT_BUDGET


def file_budget():
    try:
        value = int(os.environ.get("RULE_INJECT_FILE_BYTES") or DEFAULT_FILE_BUDGET)
    except ValueError:
        return DEFAULT_FILE_BUDGET
    return value if value > 0 else DEFAULT_FILE_BUDGET


def lock_wait():
    try:
        value = float(os.environ.get("RULE_INJECT_LOCK_WAIT") or DEFAULT_LOCK_WAIT)
    except ValueError:
        return DEFAULT_LOCK_WAIT
    return value if value > 0 else DEFAULT_LOCK_WAIT


def slug():
    root = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    return re.sub(r"[/.]", "-", root)


def state_file(session_id):
    return CACHE / slug() / "{sid}.json".format(sid=re.sub(r"[^A-Za-z0-9_-]", "_", session_id))


def load(path):
    try:
        with path.open(encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(data, fh)
    tmp.replace(path)


def sanitize(state):
    """Coerce untrusted state-file contents into safe types. A corrupt or hand-edited
    state file must degrade to 'nothing injected yet', never to a negative running spend,
    an injected set built by iterating the characters of a stored string, or an exception
    that would leave the session permanently blind to injection (a bad file is never
    rewritten unless the hook reaches save())."""
    raw_injected = state.get("injected")
    injected = ({v for v in raw_injected if isinstance(v, str)}
                if isinstance(raw_injected, list) else set())
    try:
        spent = max(0, int(state.get("spent") or 0))
    except (TypeError, ValueError):
        spent = 0
    return injected, spent


def with_lock(path, fn):
    """Run fn() while holding an exclusive lock on path's sibling .lock file for the whole
    call, so concurrent invocations for the same session serialize their read-modify-write
    instead of each racing on the same stale pre-write read. The lock lives in its own file
    so locking never depends on the state file existing yet.

    Acquisition is non-blocking and retried against a deadline (RULE_INJECT_LOCK_WAIT
    seconds, default DEFAULT_LOCK_WAIT): a PreToolUse hook must never be the reason an edit
    hangs, so a wedged or SIGSTOPed lock holder must time out rather than block the edit
    forever. On timeout this returns None — skip the injection — rather than falling
    through unlocked, since proceeding unlocked would reopen exactly the race this lock
    exists to close; skipping an injection is always safe, proceeding unlocked is not.

    If the lock file itself cannot even be set up (mkdir/open failure), that is a
    different failure mode from contention — run fn() unlocked rather than block the edit,
    keeping the overall fail-open contract."""
    lock_path = path.with_suffix(".lock")
    deadline = time.monotonic() + lock_wait()
    held = contextlib.ExitStack()
    while True:
        try:
            held.enter_context(filelock.exclusive(lock_path, blocking=False))
            break
        except filelock.Busy:
            if time.monotonic() < deadline:
                time.sleep(0.05)
                continue
            return None
        except OSError:
            return fn()
    with held:
        return fn()


def resolve(file_path, root, config=None):
    """Map the target path to (service|None, scope-relative path), or None if out of tree.

    The service is the deepest scope root (lib.service_of) holding the file, and the path is
    relative to that scope, which is what a rule's globs are written against. Unlike
    check-on-edit.py this does not filter on suffix: there the suffix decides whether a shell
    check can run at all, here the rule's own globs already decide what matches, so
    filtering twice would only hide rules from non-code files."""
    try:
        root = Path(root).resolve()
        target = Path(file_path).resolve()
        rel = target.relative_to(root)
    except (ValueError, OSError):
        return None
    config = config if config is not None else load_config(root)
    service = lib.service_of(root, target, config)
    if service is None:
        return None, str(rel)
    for scope in reversed(lib.scope_roots(root, config)[1:]):
        if scope.name == service and (target == scope or scope in target.parents):
            return service, str(target.relative_to(scope))
    return None, str(rel)


def load_config(root):
    """The project config, with its one-line stderr warning swallowed: a hook is silent."""
    with contextlib.redirect_stderr(io.StringIO()):
        return lib.load_config(Path(root))


def body(rule):
    """The rule as injected text: marker, fqid, title, trigger, rule."""
    marker = rule.severity + (",binding" if rule.override_policy == "binding" else "")
    title = " ".join(rule.title.split())
    parts = ["[{m}] {fqid} — {t}".format(m=marker, fqid=rule.fqid, t=title)]
    if rule.trigger:
        parts.append("when: " + " ".join(rule.trigger.split()))
    if rule.rule:
        parts.append(" ".join(rule.rule.split()))
    return "\n".join(parts)


def matching(rel, service, root, config=None):
    """Collapsed rules in scope for this file, blocking/binding first, then fqid.

    Override resolution runs on the full root-plus-service set, before the tiered-scope
    filter is applied: an overriding rule can live in a scope that is not itself tiered
    (and therefore never injects on its own), yet it must still suppress its target — an
    untiered service scope with an override edge would otherwise let its superseded
    root-scope default become injectable again, since that rule would never even reach
    lib.resolve_overrides(). Only after resolving overrides do we narrow down to scopes
    that build_digest.render() actually tiered — computed from the same signal render()
    uses (any resident rule in the scope) rather than hardcoding scope names, so this keeps
    working unchanged as more scopes get tiered over time.

    Only the project root and (if given) the queried service's own registry are loaded, not
    every scope_roots() root: `scoped` below is already filtered to scope in
    (root_scope, service), and `tiered` is only ever consulted as `r.scope in tiered` for
    rules drawn from `scoped`/`effective` — so a rule in any other scope root cannot change
    this function's result, provided every registry's declared `scope:` matches the root
    it lives under. validate.py reports a registry that does not as `scope_mismatch`, and
    TestRootNarrowingEquivalence pins the equivalence on a fixture.

    `include_sweep_only=True` is deliberate: `sweep_only` defers a rule's per-commit REMINDER
    line to the review sweep, which is a statement about reminder noise, not about the rule's
    body. The body is a different channel — delivered once per session, before the write, to
    inform it. Letting `sweep_only` gate this path too meant tagging a rule silently cost it
    the only edit-time exposure it had; `no_jit` is the opt-out that belongs to THIS channel,
    for a rule whose body can only help at review time (a comment-phrasing nit), never while
    the code is being written."""
    config = config if config is not None else load_config(root)
    roots = [Path(root)]
    if service:
        registry = lib.registry_root(root, service, config)
        if registry:
            roots.append(registry)
    rules = lib.load_all(roots)
    scoped = [r for r in rules if r.scope in (config["root_scope"], service)]
    effective, _ = lib.resolve_overrides(scoped, service)
    tiered = {r.scope for r in rules if r.resident}
    return sorted((r for r in effective
                   if r.scope in tiered and not r.resident and not r.no_jit
                   and lib.file_matches(r, rel, service, include_sweep_only=True)),
                  key=lambda r: (0 if ("blocking" in r.severity or r.override_policy == "binding")
                                 else 1, r.fqid))


def emit(text):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse", "additionalContext": text}}))


def pick(candidates, injected, spent, ceiling):
    """Walk precomputed candidates in priority order, filling both the session and
    per-file budgets. An over-budget rule is skipped with `continue`, not `break`: a
    single oversized rule early in the order must not starve every smaller rule behind it,
    which matters more now that a single file's own cap is much tighter than the session
    pool."""
    file_ceiling = file_budget()
    file_spent = 0
    chosen = []
    for r in candidates:
        if r.fqid in injected:
            continue
        text = body(r)
        n = len(text.encode("utf-8"))
        if spent + n > ceiling or file_spent + n > file_ceiling:
            continue
        chosen.append(text)
        injected.add(r.fqid)
        spent += n
        file_spent += n
    return chosen, spent


def build_injection(path, rel, candidates, ceiling, session_id=None, root=None):
    """Runs under the session's state-file lock: load, pick already-computed candidates
    within budget, save. The registry lookup (matching()) happens before this is called,
    outside the lock, since it reads only the YAML registries and no session state.

    The usage write is the set difference across pick(), which is exactly the rules
    delivered by THIS call: pick() skips anything already in `injected`, so a rule
    injected earlier in the session is not re-delivered and must not be re-counted.
    Writing here rather than in on_edit() also means the write inherits the state-file
    lock, so two concurrent edits cannot double-count the same delivery."""
    root = root or paths.project_root()
    state = load(path)
    injected, spent = sanitize(state)
    if spent >= ceiling:
        return None            # authoritative check: the session pool is exhausted

    before = set(injected)
    chosen, spent = pick(candidates, injected, spent, ceiling)
    if not chosen:
        return None

    state["injected"] = sorted(injected)
    state["spent"] = spent
    save(path, state)
    if session_id:
        ts = datetime.now().isoformat(timespec="seconds")
        usage.record(root, [usage.build_row(fqid, "jit_delivered", ts, session_id)
                              for fqid in sorted(injected - before)])
    return "Knowledge rules that apply to {p} and are collapsed in the digest:\n\n{b}".format(
        p=rel, b="\n\n".join(chosen))


def peek_spent(path):
    """Unlocked, best-effort read of the running session spend, used only to skip the
    registry lookup below when the pool already looks exhausted. Reads only ever lag a
    monotonically increasing value, so a stale read can under-report spend but never
    over-report it: at worst this causes one unnecessary lookup, never a missed or wrong
    budget decision, because the authoritative check happens again under the lock in
    build_injection()."""
    _, spent = sanitize(load(path))
    return spent


def on_edit(data, root=None):
    root = root or paths.project_root()
    config = load_config(root)
    tool_input = data.get("tool_input") or {}
    file_path = tool_input.get("file_path")
    session_id = data.get("session_id")
    if not isinstance(file_path, str) or not file_path or not session_id:
        return
    resolved = resolve(file_path, root, config)
    if resolved is None:
        return
    service, rel = resolved

    path = state_file(session_id)
    ceiling = budget()
    if peek_spent(path) >= ceiling:
        return

    candidates = matching(rel, service, root, config)
    if not candidates:
        return              # nothing could ever inject here; no lock is taken or created

    text = with_lock(path, lambda: build_injection(path, rel, candidates, ceiling,
                                                   session_id, root))
    if text:
        emit(text)


def main():
    if os.environ.get("RULE_INJECT_DISABLE") == "1":
        return
    if not paths.has_knowledge(paths.project_root()):
        return
    data = json.load(sys.stdin)
    if data.get("hook_event_name") != "PreToolUse":
        return
    if data.get("tool_name") not in ("Edit", "Write", "MultiEdit"):
        return
    on_edit(data)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass          # fail-open: never block a write because the hook broke
