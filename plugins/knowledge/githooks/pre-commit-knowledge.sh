#!/bin/sh
# Knowledge-base pre-commit gate. Runs the deterministic executable checks on the
# staged diff and blocks the commit on any [blocking] violation. Judgment rules are
# NOT enforced here (a shell hook cannot reason) -- use the knowledge-check skill.
# Project root and service name are derived from the repo, so this needs no config.
set -u

here=$(cd "$(dirname "$0")" && pwd) || exit 0
engine="$here/../scripts/check.py"
[ -f "$engine" ] || { echo "knowledge: engine missing at $engine; skipping gate"; exit 0; }

ctx=$(python3 "$here/../scripts/paths.py" git-context 2>/dev/null) || exit 0
root=${ctx%%	*}
service=${ctx#*	}
[ -n "$root" ] || exit 0

# staged Added/Copied/Modified files, paths relative to the repo (service) root
files=$(git diff --cached --name-only --diff-filter=ACM)
[ -n "$files" ] || exit 0

# Split the newline-separated list into positional args so each path is one argv
# entry (handles spaces in filenames); set -f stops a literal glob char expanding.
oldifs=$IFS
IFS='
'
set -f
# shellcheck disable=SC2086
set -- $files
set +f
IFS=$oldifs

# Capture output so we can tell a real violation (check.py prints a VIOLATIONS:
# header then exits 1) from an engine error (malformed YAML / import error also
# exits 1, but with NO header). Fail OPEN on engine errors -- a broken KB must not
# block every commit; only a reported violation blocks.
if [ -n "$service" ]; then
  out=$(python3 "$engine" --root "$root" --checks-only --source hook --phase commit --baseline HEAD --service "$service" "$@" 2>&1)
else
  out=$(python3 "$engine" --root "$root" --checks-only --source hook --phase commit --baseline HEAD "$@" 2>&1)
fi
rc=$?
[ -n "$out" ] && printf '%s\n' "$out"

[ "$rc" -eq 0 ] && exit 0

if printf '%s\n' "$out" | grep -q '^VIOLATIONS:'; then
  echo
  echo "knowledge: commit blocked by a [blocking] knowledge-base violation (see above)."
  echo "           fix it, or bypass with 'git commit --no-verify' if you must."
  exit 1
fi

echo
echo "knowledge: engine error (exit $rc, no violations reported); skipping gate."
exit 0
