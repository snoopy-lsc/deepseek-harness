#!/usr/bin/env bash
# Verify that /proc hides other accounts' processes. Usage: verify-hidepid.sh [instance-account ...]
# Without accounts it checks the mount; with accounts (run as root) it also lists processes as each account and
# fails if any belongs to another user. Record the result as the `process-visibility` release evidence.
set -euo pipefail
group=dsh-procview
options=$(findmnt -no OPTIONS /proc)
[[ "$options" =~ hidepid=(2|invisible) ]] || { echo "FAIL: /proc is not mounted with hidepid=2" >&2; exit 1; }
gid=$(getent group "$group" | cut -d: -f3 || true)
[[ "$gid" =~ ^[0-9]+$ ]] || { echo "FAIL: group $group is missing" >&2; exit 1; }
[[ "$options" =~ gid=$gid(,|$) ]] || { echo "FAIL: /proc hidepid exemption is not group $group" >&2; exit 1; }
for account in "$@"; do
  if id -nG "$account" | tr ' ' '\n' | grep -qx "$group"; then echo "FAIL: $account is in the exempt group $group" >&2; exit 1; fi
  uid=$(id -u "$account")
  others=$(runuser -u "$account" -- ps -eo uid=,args= | awk -v self="$uid" '$1 != self' || true)
  if [[ -n "$others" ]]; then echo "FAIL: $account can see another user's processes" >&2; exit 1; fi
done
echo "ok: /proc hides other users' processes"
