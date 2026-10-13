#!/bin/bash
# Launches a one-shot detached Codex updater; it never mutates the database.
set -euo pipefail
if [[ $# -ne 1 ]]; then
  echo 'usage: scripts/update-production.sh <path-to-new-Penkra.app>' >&2
  exit 2
fi
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec /usr/bin/python3 "$script_dir/update-production-agent.py" "$1"
