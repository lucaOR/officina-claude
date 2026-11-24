#!/bin/sh
# Install the knowledge pre-commit gate and post-commit marker into a repo's git hooks dir.
# Usage: install-git-hooks.sh <repo>
# Each shim records this plugin's absolute githooks/ path. If that path disappears (a plugin
# update moves the install), the shim asks the copy of locate.py kept beside it, and fails
# open (exit 0) if the plugin cannot be found at all.
# The hooks dir honours core.hooksPath. When that points inside the work tree (a tracked
# directory such as husky's), the installer refuses: a shim there would commit this
# machine's absolute plugin path into the repository.
set -u

repo=${1:-}
[ -n "$repo" ] || { echo "usage: install-git-hooks.sh <repo>" >&2; exit 2; }
here=$(cd "$(dirname "$0")" && pwd) || exit 1
hooks=$(git -C "$repo" rev-parse --path-format=absolute --git-path hooks) || {
  echo "knowledge: $repo is not a git repository" >&2; exit 1; }
marker="knowledge pre-commit gate"

top=$(git -C "$repo" rev-parse --path-format=absolute --show-toplevel 2>/dev/null) || top=""
common=$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || common=""
if [ -n "$top" ]; then
  case "$hooks/" in
    "${common:-//none}"/*) ;;
    "$top"/*)
      echo "knowledge: $hooks is inside the work tree (core.hooksPath), so the hooks would be committed with this machine's plugin path; leaving it untouched. Call \"$here/pre-commit-knowledge.sh\" from your own pre-commit hook instead." >&2
      exit 1 ;;
  esac
fi

for name in pre-commit post-commit; do
  if [ -e "$hooks/$name" ] && ! grep -q "$marker" "$hooks/$name"; then
    case $name in
      pre-commit) gate="pre-commit-knowledge.sh" ;;
      *) gate="postcommit.py" ;;
    esac
    echo "knowledge: $hooks/$name already exists and is not ours; leaving it untouched. Call \"$here/$gate\" from your own $name hook instead." >&2
    exit 1
  fi
done

mkdir -p "$hooks" || exit 1
cp "$here/../scripts/locate.py" "$hooks/knowledge-locate.py" || exit 1

# $1 = hook name, $2 = script run from githooks/, $3 = extra args
write_shim() {
  {
    printf '#!/bin/sh\n'
    printf '# %s (installed by the knowledge plugin; safe to delete)\n' "$marker"
    printf 'k_githooks=%s\n' "$(printf '%s' "$here" | sed "s/'/'\\\\''/g; s/^/'/; s/\$/'/")"
    cat <<'BODY'
hooks_dir=$(cd "$(dirname "$0")" && pwd)
if [ ! -f "$k_githooks/SCRIPT" ]; then
  # A project-scoped install is keyed on the project root, which is the repo's toplevel,
  # its superproject or its parent directory, so try the toplevel and then each ancestor.
  dir=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
  found=""
  while :; do
    found=$(python3 "$hooks_dir/knowledge-locate.py" "$dir" 2>/dev/null) && break
    found=""
    parent=$(dirname "$dir")
    [ "$parent" != "$dir" ] || break
    dir=$parent
  done
  if [ -n "$found" ] && [ -f "$found/githooks/SCRIPT" ]; then
    k_githooks="$found/githooks"
  else
    echo "knowledge plugin not found: re-run /knowledge:setup to reinstall the git gate" >&2
    exit 0
  fi
fi
RUN
BODY
  } | sed "s|SCRIPT|$2|g; s|^RUN$|$3|" > "$hooks/$1.tmp.$$" || exit 1
  chmod +x "$hooks/$1.tmp.$$" && mv "$hooks/$1.tmp.$$" "$hooks/$1"
}

write_shim pre-commit pre-commit-knowledge.sh 'exec sh "$k_githooks/pre-commit-knowledge.sh"'
write_shim post-commit postcommit.py 'python3 "$k_githooks/postcommit.py" >/dev/null 2>\&1; exit 0'
echo "knowledge: git gate installed in $hooks"
