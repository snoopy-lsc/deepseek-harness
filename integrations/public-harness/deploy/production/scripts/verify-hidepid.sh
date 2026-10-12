#!/usr/bin/env bash
# Verify that /proc hides other accounts' processes. Usage: verify-hidepid.sh [instance-account ...]
# Without accounts it checks the mount; with accounts (run as root) it also lists processes as each account and
# fails if any belongs to another user. An account's own rootless sandbox processes run under its subuid range
# (/etc/subuid, or DSH_SUBUID_FILE) and are not foreign; every other account's range still is. Record the result as the `process-visibility` release evidence.
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
  ranges=$(awk -F: -v name="$account" -v id="$uid" '$1 == name || $1 == id { printf "%s%d-%d", sep, $2, $2 + $3 - 1; sep = "," }' "${DSH_SUBUID_FILE:-/etc/subuid}" 2>/dev/null || true)
  others=$(runuser -u "$account" -- ps -eo uid=,args= | awk -v self="$uid" -v ranges="$ranges" '
    BEGIN { n = split(ranges, own, ",") }
    $1 == self { next }
    { for (i = 1; i <= n; i++) { split(own[i], bounds, "-"); if ($1 + 0 >= bounds[1] + 0 && $1 + 0 <= bounds[2] + 0) next } print }' || true)
  if [[ -n "$others" ]]; then echo "FAIL: $account can see another user's processes" >&2; exit 1; fi
done
echo "ok: /proc hides other users' processes"
