#!/usr/bin/env bash
# Placeholder: replace this with the project's baseline restore.
#
# The harness calls this file before every row (config `reset.baseline`).
# What it must do: put the project's data back in its known starting state, so one row's writes
# can never leak into the next. It must be fast, because it runs once per row.
# Exit 0 once the data is restored. Any other exit fails the row's reset, so the row is BLOCKED.
# This placeholder exits 78 on purpose: a baseline that restored nothing would let every row run on
# whatever the previous one left behind.
echo "baseline.sh is a placeholder: edit .claude/scenarios/_infra/baseline.sh so it restores the data to its known state." >&2
exit 78
