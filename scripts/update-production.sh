#!/bin/bash
# Invokes the committed one-shot updater; no agent generates release code.
set -euo pipefail
if [[ $# -ne 1 ]]; then
  echo 'usage: scripts/update-production.sh <path-to-new-Penkra.app>' >&2
  exit 2
fi
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec /usr/bin/python3 "$script_dir/production-update/helper.py" --production "$1"
