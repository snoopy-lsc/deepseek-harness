#!/usr/bin/env bash
# Restore a backup made by backup.sh into an EMPTY target (a rehearsal host, or after wiping a failed one).
# Usage: restore.sh <backup-dir>      Services must be stopped; refuses to overwrite existing state.
set -euo pipefail
umask 077
from=${1:?backup directory}
state=/var/lib/dsh-public
systemctl is-active --quiet dsh-public.target && { echo "stop dsh-public.target first" >&2; exit 2; }
[[ -z $(ls -A "$state/state" "$state/storage" 2>/dev/null || true) ]] || { echo "target state is not empty" >&2; exit 2; }
( cd "$from" && sha256sum --check --quiet SHA256SUMS )
mkdir -p "$state"
tar --extract --file "$from/provisioner-state.tar" --directory "$state"
tar --extract --acls --xattrs --numeric-owner --file "$from/storage.tar" --directory "$state"
mkdir -p "$state/quota"
for db in "$from"/quota-*; do
  [[ -e $db ]] || continue
  install -o dsh-quota -g dsh-quota -m 0600 "$db" "$state/quota/${db##*/quota-}"
done
tar --extract --file "$from/config.tar" --directory /etc
echo "restored; run: systemctl start dsh-public.target && dshctl reconcile"
