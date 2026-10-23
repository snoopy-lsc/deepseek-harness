#!/usr/bin/env bash
# Install reconcile-entry.mjs (+ plugin-sync) into a native release directory.
# Usage: package-reconcile-entry.sh <integration-root> <release-dir>
set -euo pipefail
root=${1:?integration root}; dest=${2:?release dir}
[[ -f $root/packages/plugins/lib/package-reconcile-entry.js ]] || { echo "build plugins first" >&2; exit 2; }
[[ -f $root/packages/plugin-sync/lib/index.js ]] || { echo "build plugin-sync first" >&2; exit 2; }
mkdir -p "$dest"
node "$root/packages/plugins/lib/package-reconcile-entry.js" "$dest"
