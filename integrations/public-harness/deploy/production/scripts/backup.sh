#!/usr/bin/env bash
# Consistent backup of provisioner state, user storage, and the quota ledger. Run as root; output stays root-only.
# Usage: backup.sh <backup-root>
set -euo pipefail
umask 077
out=${1:?backup root}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
dest="$out/$stamp"
mkdir -p "$dest"
state=/var/lib/dsh-public
# 1. Quota ledger: SQLite online backup (never copy a live database file).
for db in "$state"/quota/*.db "$state"/quota/*.sqlite; do
  [[ -e $db ]] || continue
  sqlite3 "$db" ".backup '$dest/quota-$(basename "$db")'"
done
# 2. Provisioner lifecycle records, then each user's storage with ownership and ACLs preserved.
tar --create --file "$dest/provisioner-state.tar" --directory "$state" state
tar --create --acls --xattrs --numeric-owner --one-file-system --file "$dest/storage.tar" --directory "$state" storage
# 3. Deployment configuration (no secrets live here; secrets are backed up through the operator's secret manager).
tar --create --file "$dest/config.tar" --directory /etc dsh-public --exclude=dsh-public/secrets
( cd "$dest" && sha256sum ./* > SHA256SUMS )
echo "$dest"
