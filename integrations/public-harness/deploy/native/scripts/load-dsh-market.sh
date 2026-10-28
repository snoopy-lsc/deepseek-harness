#!/usr/bin/env bash
# Load the native per-owner market table `inet dsh_market` from the rendered ruleset file.
# Installed as /usr/lib/dsh-public/load-dsh-market.sh (root:root 0755) and run by dsh-plugins.socket as
#   ExecStartPost=/usr/lib/dsh-public/load-dsh-market.sh /etc/dsh-public/dsh-market.nft
# without the "-" prefix, so a failure here fails the socket unit and closes every market listener (fail closed).
# The provisioner's market probe reruns it when the table or a chain has gone missing.
#
# Idempotent and atomic: the file creates the table and set if absent and flushes and refills only the chains, in a
# single `nft -f` transaction, so a reload never empties market_owner and a bad file changes nothing.
# Exit codes: 0 loaded and verified, 1 load or verification failed, 2 refused (usage, not root, unsafe file).
# Never prints environment variables; the ruleset holds no secrets.
set -euo pipefail
umask 077

readonly TABLE=dsh_market
nft=${DSH_NFT:-/usr/sbin/nft}
rules=${1:-/etc/dsh-public/dsh-market.nft}

refuse() { printf 'load-dsh-market: refusing: %s\n' "$1" >&2; exit 2; }
fail() { printf 'load-dsh-market: FAILED: %s\n' "$1" >&2; exit 1; }

(($# <= 1)) || refuse "usage: load-dsh-market.sh [RULES_FILE]"
[[ $rules == /* ]] || refuse "rules file must be an absolute path"
[[ $(id -u) -eq 0 ]] || refuse "root is required"
[[ -x $nft ]] || fail "nft not found at $nft"

# The file must be a regular, root-owned file that nobody else can write, reached without a symlink.
[[ -f $rules && ! -L $rules ]] || refuse "$rules is missing or not a regular file"
read -r owner mode < <(stat -c '%u %a' -- "$rules")
[[ $owner == 0 ]] || refuse "$rules is not owned by root"
(((8#$mode & 8#022) == 0)) || refuse "$rules is group- or world-writable"

# Allowlist: comments, the single MARKET_PORTS define, and add/flush statements on inet dsh_market only.
# Mirrors MARKET_RULE_LINE in packages/runtime-systemd/src/market-firewall.ts.
allowed='^(#.*|define MARKET_PORTS = [0-9]{1,5}-[0-9]{1,5}|(add|flush) (table|set|chain|rule) inet dsh_market( .*)?)$'
defines=0
while IFS= read -r line || [[ -n $line ]]; do
  [[ -z ${line//[[:space:]]/} ]] && continue
  [[ $line =~ $allowed ]] || refuse "$rules has a statement outside inet $TABLE"
  [[ $line == "define MARKET_PORTS = "* ]] && defines=$((defines + 1))
done <"$rules"
((defines == 1)) || refuse "$rules must define MARKET_PORTS exactly once"
ports=$(sed -nE 's/^define MARKET_PORTS = ([0-9]+-[0-9]+)$/\1/p' "$rules")

# Check, then load in one transaction.
"$nft" -c -f "$rules" || fail "nft rejected $rules (check); nothing was changed"
"$nft" -f "$rules" || fail "nft could not load $rules; nothing was changed"

# Verify the loaded state, not the file: both chains with their drops and the owner set.
input=$("$nft" list chain inet "$TABLE" input 2>/dev/null) || fail "chain input missing after load"
listener=$("$nft" list chain inet "$TABLE" market_listener 2>/dev/null) || fail "chain market_listener missing after load"
"$nft" list set inet "$TABLE" market_owner >/dev/null 2>&1 || fail "set market_owner missing after load"
grep -Fq '@market_owner drop' <<<"$input" || fail "owner drop rule missing after load"
grep -Eq 'socket cgroupv2 level [0-9]+ ".+" return' <<<"$listener" || fail "listener cgroup rule missing after load"
grep -Eq '^[[:space:]]*drop$' <<<"$listener" || fail "listener drop rule missing after load"

cgroup=$(sed -nE 's/^add rule inet dsh_market market_listener socket cgroupv2 level ([0-9]+) "([^"]+)" return$/\2 (level \1)/p' "$rules")
printf 'load-dsh-market: loaded inet %s (ports %s, listener %s)\n' "$TABLE" "$ports" "$cgroup" >&2
