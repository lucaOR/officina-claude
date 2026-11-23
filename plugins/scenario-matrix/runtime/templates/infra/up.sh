#!/usr/bin/env bash
# Placeholder: replace this with the project's bring-up.
#
# run.mjs calls this file once per run (config `lifecycle.up`), before any row.
# What it must do: start the stack the scenarios run against, and wait until that stack is ready.
# Wait on a real readiness signal (a health endpoint answering, a port accepting connections, a
# marker line in a log), never on a fixed sleep.
# Exit 0 when the stack is ready. Exit 78 when it refuses to start and changed nothing:
# run.mjs then reports the run as blocked and tears nothing down.
echo "up.sh is a placeholder: edit .claude/scenarios/_infra/up.sh so it starts the stack and waits until it is ready, without sleeping a fixed time." >&2
exit 78
