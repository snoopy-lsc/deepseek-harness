#!/usr/bin/env bash
# Hide other accounts' processes (and their podman/runsc command lines) from instance accounts: mount /proc with
# hidepid=2 and let only the dsh-procview group, root, and systemd-logind see everything. Run once as root after
# systemd-sysusers; it is idempotent. Usage: enable-hidepid.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
group=dsh-procview
gid=$(getent group "$group" | cut -d: -f3 || true)
[[ "$gid" =~ ^[0-9]+$ ]] || { echo "group $group is missing; run systemd-sysusers first" >&2; exit 1; }
options="nosuid,nodev,noexec,hidepid=2,gid=$gid"
cp -p /etc/fstab /etc/fstab.dsh-backup
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
{ grep -v -E '^proc[[:space:]]+/proc[[:space:]]' /etc/fstab || true; echo "proc /proc proc $options 0 0"; } > "$tmp"
install -m 0644 "$tmp" /etc/fstab
install -D -m 0644 "$here/../logind-dropin/dsh-public.conf" /etc/systemd/system/systemd-logind.service.d/dsh-public.conf
systemctl daemon-reload
mount -o "remount,$options" /proc
systemctl restart systemd-logind
"$here/verify-hidepid.sh"
