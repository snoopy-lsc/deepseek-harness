#!/usr/bin/env bash
# Phase 0 privileged rehearsal for the native runtime: P0.4, P0.5 and P0.8.
# Runs only as root on a dedicated systemd host with DSH_NATIVE_REHEARSAL=dedicated-host; --dry-run prints the plan
# and touches nothing. Every probe resource is named dsh-p0-* / dsh_p0_probe and removed on exit. Never prints
# environment variables or secrets; captured output is redacted before it is written. See README.md next to it.
set -uo pipefail
umask 077

readonly PROBE_TABLE=dsh_p0_probe
readonly MARKET_TABLE=dsh_market
readonly PROBE_SLICE=dsh-p0-probe.slice

dry_run=0
only="P0.4,P0.5,P0.8"
evidence_dir=""
account="nobody"
node_bin=""
pnpm_bin=""
probe_port=28672
socket_unit="dsh-plugins.socket"
container=0
container_image=""
pasta_address="169.254.1.2"

usage() {
  cat <<'USAGE'
usage: p0-rehearsal.sh [--dry-run] [--only P0.4,P0.5,P0.8] [--evidence-dir DIR] [--account USER]
                       [--node PATH] [--pnpm PATH] [--probe-port PORT] [--socket-unit UNIT]
                       [--container --container-image IMAGE [--pasta-address ADDR]]
Exit codes: 0 every selected probe PASS, 1 a probe FAILED, 2 refused or bad usage, 3 incomplete (SKIP or BLOCKED).
USAGE
}

die_usage() { printf 'p0-rehearsal: %s\n' "$1" >&2; usage >&2; exit 2; }

while (($#)); do
  case $1 in
    --dry-run) dry_run=1 ;;
    --only) only=${2:-}; shift ;;
    --evidence-dir) evidence_dir=${2:-}; shift ;;
    --account) account=${2:-}; shift ;;
    --node) node_bin=${2:-}; shift ;;
    --pnpm) pnpm_bin=${2:-}; shift ;;
    --probe-port) probe_port=${2:-}; shift ;;
    --socket-unit) socket_unit=${2:-}; shift ;;
    --container) container=1 ;;
    --container-image) container_image=${2:-}; shift ;;
    --pasta-address) pasta_address=${2:-}; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die_usage "unknown option: $1" ;;
  esac
  shift
done

[[ $only =~ ^(P0\.[458])(,P0\.[458])*$ ]] || die_usage "--only takes a comma list of P0.4, P0.5, P0.8"
if [[ ! $probe_port =~ ^[0-9]+$ ]] || ((probe_port < 1024 || probe_port > 65535)); then die_usage "--probe-port must be 1024-65535"; fi
[[ $account =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die_usage "--account must be a plain Linux user name"
[[ $socket_unit =~ ^[A-Za-z0-9@_.-]+\.socket$ ]] || die_usage "--socket-unit must name a .socket unit"
[[ $pasta_address =~ ^[0-9.]+$ ]] || die_usage "--pasta-address must be an IPv4 address"
if ((container)) && [[ -z $container_image ]]; then die_usage "--container needs --container-image"; fi
[[ -z $evidence_dir || $evidence_dir == /* ]] || die_usage "--evidence-dir must be absolute"

selected() { [[ ,$only, == *",$1,"* ]]; }

# ---- refusal guards: the real run needs root, a running systemd and the dedicated-host opt-in ----
if ((!dry_run)); then
  if [[ $(id -u) -ne 0 ]]; then echo "p0-rehearsal: refusing to run: root is required (use --dry-run to see the plan)" >&2; exit 2; fi
  if [[ ! -d /run/systemd/system ]]; then echo "p0-rehearsal: refusing to run: systemd is not the running init" >&2; exit 2; fi
  if [[ ${DSH_NATIVE_REHEARSAL:-} != dedicated-host ]]; then
    echo "p0-rehearsal: refusing to run: set DSH_NATIVE_REHEARSAL=dedicated-host on a dedicated rehearsal host" >&2; exit 2
  fi
fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
[[ -n $evidence_dir ]] || evidence_dir="/var/lib/dsh-public/rehearsal/p0-$stamp"

# ---- output helpers ----
declare -A RESULT=() DETAIL=()
ORDER=()

# Mask anything that looks like a credential before it reaches the terminal or the evidence directory.
redact() {
  sed -E \
    -e 's/(sk-|sk_live_|ghp_|gho_|github_pat_|xox[abp]-)[A-Za-z0-9_-]{6,}/\1[REDACTED]/g' \
    -e 's/(Bearer|Basic) [A-Za-z0-9._~+\/=-]{8,}/\1 [REDACTED]/g' \
    -e 's/([A-Za-z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH)[A-Za-z0-9_]*[=:][[:space:]]*)[^[:space:]]+/\1[REDACTED]/Ig' \
    -e 's/(_authToken|_auth|_password)=.*/\1=[REDACTED]/g' \
    -e 's/-----BEGIN [A-Z ]*PRIVATE KEY-----.*/[REDACTED PRIVATE KEY]/g'
}

say() { printf '%s\n' "$*" | redact; }
plan() { say "  [plan] $*"; }

record() { # record <probe> <PASS|FAIL|SKIP|BLOCKED> <detail>
  RESULT[$1]=$2; DETAIL[$1]=$3; ORDER+=("$1")
  say "$(printf '%-7s %-5s %s' "$2" "$1" "$3")"
}

log_file() { printf '%s/%s.log' "$evidence_dir" "$1"; }
# capture <probe> <label> <command...>: run, append redacted output to the probe log, return the exit status.
capture() {
  local probe=$1 label=$2; shift 2
  local out status
  out=$("$@" 2>&1); status=$?
  { printf '## %s (exit %d)\n$ %s\n' "$label" "$status" "$*"; printf '%s\n' "$out"; } | redact >>"$(log_file "$probe")"
  CAPTURED=$out
  return "$status"
}

# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
  ((dry_run)) && return 0
  nft delete table inet "$PROBE_TABLE" >/dev/null 2>&1 || true
  systemctl stop dsh-p0-listener.service >/dev/null 2>&1 || true
  [[ -n ${work:-} && -d ${work:-} ]] && rm -rf -- "$work"
  return 0
}
trap cleanup EXIT
trap 'exit 130' INT TERM

resolve_tools() {
  if [[ -z $node_bin ]]; then
    for c in /opt/dsh-public/toolchain/node /usr/bin/node; do [[ -x $c ]] && { node_bin=$c; break; }; done
  fi
  if [[ -z $pnpm_bin ]]; then
    for c in /opt/dsh-public/toolchain/pnpm /usr/bin/pnpm /usr/local/bin/pnpm; do [[ -x $c ]] && { pnpm_bin=$c; break; }; done
  fi
}

# Node one-liner: connect to host:port; prints "connected" or the error code, exits 0 only when connected.
connect_js='const [h,p]=process.argv.slice(1);const s=require("net").connect({host:h,port:+p});const t=setTimeout(()=>{console.log("timeout");process.exit(3)},2500);s.on("connect",()=>{console.log("connected");clearTimeout(t);s.destroy();process.exit(0)});s.on("error",e=>{console.log(e.code||"error");clearTimeout(t);process.exit(2)})'

start_listener() { # transient root-owned loopback listener on probe_port for the duration of the run
  systemd-run --unit=dsh-p0-listener --collect --quiet --property=RuntimeMaxSec=600 -- "$node_bin" -e \
    'require("net").createServer(c=>c.end()).listen(+process.argv[1],"127.0.0.1")' "$probe_port" >/dev/null 2>&1
  local _; for _ in 1 2 3 4 5 6 7 8 9 10; do ss -ltnH "sport = :$probe_port" | grep -q . && return 0; sleep 0.3; done
  return 1
}

# ---------------------------------------------------------------- P0.4
p04_dry() {
  say "P0.4 reconcile transient unit: slice, loopback-only network, hostile pnpmfile and userconfig ignored"
  plan "create a work dir under /var/tmp owned by --account ($account) with package.json (no dependencies), a throwing .pnpmfile.cjs and a hostile .npmrc"
  plan "systemd-run --wait --collect --pipe --slice=$PROBE_SLICE --uid=<account> --gid=<account> with the reconcile properties"
  plan "  (NoNewPrivileges, CapabilityBoundingSet=, ProtectSystem=strict, ProtectHome=yes, ReadWritePaths=<work>, IPAddressDeny=any, IPAddressAllow=localhost, RuntimeMaxSec=300)"
  plan "inside the unit: /proc/self/cgroup names $PROBE_SLICE; 127.0.0.1:$probe_port connects; 192.0.2.1:80 is refused"
  plan "inside the unit: pnpm install --offline fails without the flags and passes with --ignore-pnpmfile --config.userconfig=/dev/null"
}

p04_run() {
  local probe=P0.4
  resolve_tools
  [[ -x $node_bin ]] || { record $probe BLOCKED "no node toolchain (pass --node)"; return; }
  [[ -x $pnpm_bin ]] || { record $probe BLOCKED "no pnpm binary (pass --pnpm)"; return; }
  id -u "$account" >/dev/null 2>&1 || { record $probe BLOCKED "account $account does not exist"; return; }
  local uid gid; uid=$(id -u "$account"); gid=$(id -g "$account")
  ((uid != 0)) || { record $probe BLOCKED "--account must not be root"; return; }
  start_listener || { record $probe BLOCKED "could not start the loopback listener on $probe_port"; return; }
  work=$(mktemp -d /var/tmp/dsh-p0-XXXXXX)
  mkdir -p "$work/project" "$work/home" "$work/cache" "$work/tmp"
  printf '{"name":"dsh-p0-probe","version":"0.0.0","private":true}\n' >"$work/project/package.json"
  printf 'throw new Error("hostile pnpmfile executed")\n' >"$work/project/.pnpmfile.cjs"
  # Hostile user config: an unreachable registry and a fake token that must never be read (and is redacted anyway).
  printf 'registry=http://192.0.2.1/\n//192.0.2.1/:_authToken=dsh-p0-placeholder\n' >"$work/home/.npmrc"
  chown -R "$uid:$gid" "$work"; chmod 0700 "$work"
  local -a base=(systemd-run --wait --collect --pipe --quiet "--slice=$PROBE_SLICE" "--uid=$uid" "--gid=$gid"
    --property=NoNewPrivileges=yes --property=CapabilityBoundingSet= --property=ProtectSystem=strict --property=ProtectHome=yes
    "--property=ReadWritePaths=$work" --property=IPAddressDeny=any --property=IPAddressAllow=localhost --property=RuntimeMaxSec=300
    "--working-directory=$work/project" "--setenv=HOME=$work/home" "--setenv=XDG_CACHE_HOME=$work/cache" "--setenv=TMPDIR=$work/tmp"
    "--setenv=PATH=$(dirname "$node_bin"):/usr/bin:/usr/sbin" --)
  local failures=()
  capture $probe "cgroup" "${base[@]}" /bin/cat /proc/self/cgroup
  [[ $CAPTURED == *"$PROBE_SLICE"* ]] || failures+=("unit not in $PROBE_SLICE")
  capture $probe "loopback allowed" "${base[@]}" "$node_bin" -e "$connect_js" 127.0.0.1 "$probe_port" || failures+=("loopback connect failed: $CAPTURED")
  capture $probe "public denied" "${base[@]}" "$node_bin" -e "$connect_js" 192.0.2.1 80 && failures+=("non-loopback connect succeeded")
  [[ $CAPTURED == *EPERM* || $CAPTURED == *EACCES* ]] || failures+=("non-loopback connect was not refused by IPAddressDeny (got $CAPTURED)")
  capture $probe "pnpm without flags (must fail)" "${base[@]}" "$pnpm_bin" install --offline && failures+=("hostile pnpmfile did not stop a plain install")
  capture $probe "pnpm with flags (must pass)" "${base[@]}" "$pnpm_bin" install --offline --ignore-pnpmfile --config.userconfig=/dev/null \
    || failures+=("install with --ignore-pnpmfile --config.userconfig=/dev/null failed")
  [[ $CAPTURED != *"hostile pnpmfile executed"* ]] || failures+=("pnpmfile ran despite --ignore-pnpmfile")
  if ((${#failures[@]})); then record $probe FAIL "$(IFS=';'; echo "${failures[*]}")"; else record $probe PASS "slice, loopback-only network and pnpm hardening held"; fi
}

# ---------------------------------------------------------------- P0.5
p05_dry() {
  say "P0.5 meta skuid matching (native) and, with --container, through pasta"
  plan "nft add table inet $PROBE_TABLE with an output chain counting 'oif lo meta skuid <uid> tcp dport $probe_port' for --account and for root"
  plan "connect to 127.0.0.1:$probe_port as --account ($account) in a transient unit, then as root; each counter must move only for its own uid"
  if ((container)); then
    plan "as --account: podman run --rm --runtime=runsc --network=pasta:--map-host-loopback,$pasta_address,--no-splice $container_image node -e <connect $pasta_address:$probe_port>"
    plan "the --account counter must move for the container connection"
  else
    plan "container part skipped (no --container): P0.5 stays incomplete until it runs on a container host"
  fi
  plan "the one-shot reconcile container argv shape is covered by assertSafeReconcileArgv unit tests, not by this script"
  plan "nft delete table inet $PROBE_TABLE"
}

counter() { # counter <comment> -> packets of the rule tagged with that comment
  nft -a list chain inet "$PROBE_TABLE" out 2>/dev/null | awk -v tag="\"$1\"" '$0 ~ tag { for (i = 1; i <= NF; i++) if ($i == "packets") print $(i + 1) }' | head -n1
}

p05_run() {
  local probe=P0.5
  resolve_tools
  command -v nft >/dev/null || { record $probe BLOCKED "nft not installed"; return; }
  [[ -x $node_bin ]] || { record $probe BLOCKED "no node toolchain (pass --node)"; return; }
  id -u "$account" >/dev/null 2>&1 || { record $probe BLOCKED "account $account does not exist"; return; }
  local uid; uid=$(id -u "$account")
  ss -ltnH "sport = :$probe_port" | grep -q . || start_listener || { record $probe BLOCKED "could not start the loopback listener"; return; }
  nft delete table inet "$PROBE_TABLE" >/dev/null 2>&1
  capture $probe "probe table" nft -f - <<NFT || { record $probe FAIL "could not load the probe table"; return; }
add table inet $PROBE_TABLE
add chain inet $PROBE_TABLE out { type filter hook output priority filter - 3 ; policy accept ; }
add rule inet $PROBE_TABLE out oif "lo" tcp dport $probe_port tcp flags syn meta skuid $uid counter comment "account"
add rule inet $PROBE_TABLE out oif "lo" tcp dport $probe_port tcp flags syn meta skuid 0 counter comment "root"
NFT
  local failures=()
  capture $probe "connect as $account" systemd-run --wait --collect --pipe --quiet "--uid=$uid" -- "$node_bin" -e "$connect_js" 127.0.0.1 "$probe_port" \
    || failures+=("account connect failed: $CAPTURED")
  local a1 r1; a1=$(counter account); r1=$(counter root)
  capture $probe "connect as root" "$node_bin" -e "$connect_js" 127.0.0.1 "$probe_port" || failures+=("root connect failed")
  local a2 r2; a2=$(counter account); r2=$(counter root)
  capture $probe "counters" nft list table inet "$PROBE_TABLE"
  ((${a1:-0} >= 1)) || failures+=("skuid $uid did not match the account connection")
  ((${r1:-0} == 0)) || failures+=("root rule matched the account connection")
  ((${a2:-0} == ${a1:-0})) || failures+=("account rule matched the root connection")
  ((${r2:-0} >= 1)) || failures+=("skuid 0 did not match the root connection")
  local partial=""
  if ((container)); then
    if ! command -v podman >/dev/null || ! command -v runsc >/dev/null || ! command -v pasta >/dev/null; then
      partial="container part BLOCKED: podman, runsc or pasta missing"
    else
      capture $probe "connect from runsc container via pasta" runuser -u "$account" -- podman run --rm --runtime=runsc \
        "--network=pasta:--map-host-loopback,$pasta_address,--no-splice" "$container_image" node -e "$connect_js" "$pasta_address" "$probe_port" \
        || failures+=("container connect through pasta failed: $CAPTURED")
      local a3; a3=$(counter account)
      ((${a3:-0} > ${a2:-0})) || failures+=("skuid $uid did not match the connection made through pasta")
    fi
  else
    partial="container part SKIPPED (no --container)"
  fi
  if ((${#failures[@]})); then record $probe FAIL "$(IFS=';'; echo "${failures[*]}")"
  elif [[ -n $partial ]]; then record $probe SKIP "native skuid matching passed; $partial"
  else record $probe PASS "skuid matched per uid natively and through pasta"; fi
  nft delete table inet "$PROBE_TABLE" >/dev/null 2>&1
}

# ---------------------------------------------------------------- P0.8
p08_dry() {
  say "P0.8 listener cgroup of $socket_unit and the $MARKET_TABLE loader, before and after a socket restart"
  plan "require $socket_unit active; read its first ListenStream port"
  plan "ss -ltn --cgroup on that port; nft probe table $PROBE_TABLE counting SYNs whose listener is 'socket cgroupv2 level 1 \"init.scope\"' or 'level 2 \"system.slice/$socket_unit\"'"
  plan "connect once as root; the matching counter names the listener cgroup"
  plan "nft list table inet $MARKET_TABLE must exist and its market_listener rule must name the measured cgroup"
  plan "systemctl restart $socket_unit, then repeat the measurement and the $MARKET_TABLE check (ExecStartPost loader reran)"
  plan "nft delete table inet $PROBE_TABLE (the $MARKET_TABLE table is only read)"
}

measure_listener() { # measure_listener <port> <probe-log>: prints init.scope|socket-unit|unknown
  nft delete table inet "$PROBE_TABLE" >/dev/null 2>&1
  nft -f - >/dev/null 2>&1 <<NFT || { echo unknown; return; }
add table inet $PROBE_TABLE
add chain inet $PROBE_TABLE in { type filter hook input priority filter - 3 ; policy accept ; }
add rule inet $PROBE_TABLE in iif "lo" tcp dport $1 tcp flags syn socket cgroupv2 level 1 "init.scope" counter comment "init"
NFT
  # The socket unit's own cgroup may not exist (systemd creates it only while an Exec* command runs); nft refuses
  # a path that does not exist, so this rule is optional and its absence is itself evidence.
  if ! nft add rule inet "$PROBE_TABLE" in iif lo tcp dport "$1" tcp flags syn socket cgroupv2 level 2 "\"system.slice/$socket_unit\"" counter comment '"unit"' >/dev/null 2>&1; then
    printf 'note: cgroup system.slice/%s does not exist; level 2 rule not loadable\n' "$socket_unit" >>"$2"
  fi
  "$node_bin" -e "$connect_js" 127.0.0.1 "$1" >/dev/null 2>&1
  local listing init unit
  listing=$(nft list chain inet "$PROBE_TABLE" in 2>/dev/null)
  printf '## probe counters\n%s\n' "$listing" | redact >>"$2"
  init=$(awk '/"init"/ { for (i = 1; i <= NF; i++) if ($i == "packets") print $(i + 1) }' <<<"$listing" | head -n1)
  unit=$(awk '/"unit"/ { for (i = 1; i <= NF; i++) if ($i == "packets") print $(i + 1) }' <<<"$listing" | head -n1)
  nft delete table inet "$PROBE_TABLE" >/dev/null 2>&1
  if ((${init:-0} > 0)) && ((${unit:-0} == 0)); then echo init.scope
  elif ((${unit:-0} > 0)) && ((${init:-0} == 0)); then echo socket-unit
  else echo unknown; fi
}

market_rule_matches() { # market_rule_matches <measured> -> 0 when dsh_market names that cgroup
  local rules; rules=$(nft list chain inet "$MARKET_TABLE" market_listener 2>/dev/null) || return 2
  case $1 in
    init.scope) grep -Eq 'socket cgroupv2 level 1 "init\.scope"' <<<"$rules" ;;
    socket-unit) grep -Fq "socket cgroupv2 level 2 \"system.slice/$socket_unit\"" <<<"$rules" ;;
    *) return 1 ;;
  esac
}

p08_run() {
  local probe=P0.8
  resolve_tools
  command -v nft >/dev/null || { record $probe BLOCKED "nft not installed"; return; }
  [[ -x $node_bin ]] || { record $probe BLOCKED "no node toolchain (pass --node)"; return; }
  systemctl is-active --quiet "$socket_unit" || { record $probe BLOCKED "$socket_unit is not active; install and start it first"; return; }
  local listen port
  listen=$(systemctl show -p Listen --value "$socket_unit" | head -n1)
  port=$(sed -nE 's/^[^ ]*:([0-9]+) .*/\1/p' <<<"$listen")
  [[ -n $port ]] || { record $probe BLOCKED "could not read a ListenStream port from $socket_unit"; return; }
  capture $probe "unit" systemctl cat "$socket_unit"
  local failures=() before after
  capture $probe "listener before restart" ss -ltnH --cgroup "sport = :$port"
  before=$(measure_listener "$port" "$(log_file $probe)"); say "        P0.8  listener cgroup before restart: $before"
  [[ $before != unknown ]] || failures+=("listener cgroup not identified before restart")
  capture $probe "$MARKET_TABLE before restart" nft list table inet "$MARKET_TABLE" || failures+=("$MARKET_TABLE missing before restart (loader did not run)")
  market_rule_matches "$before" || failures+=("$MARKET_TABLE market_listener does not name $before before restart")
  capture $probe "restart" systemctl restart "$socket_unit" || failures+=("systemctl restart $socket_unit failed")
  sleep 1
  capture $probe "listener after restart" ss -ltnH --cgroup "sport = :$port"
  after=$(measure_listener "$port" "$(log_file $probe)"); say "        P0.8  listener cgroup after restart: $after"
  [[ $after == "$before" ]] || failures+=("listener cgroup changed across restart ($before -> $after)")
  capture $probe "$MARKET_TABLE after restart" nft list table inet "$MARKET_TABLE" || failures+=("$MARKET_TABLE missing after restart")
  market_rule_matches "$after" || failures+=("$MARKET_TABLE market_listener does not name $after after restart")
  if ((${#failures[@]})); then record $probe FAIL "$(IFS=';'; echo "${failures[*]}")"
  else record $probe PASS "listener cgroup $before (level $([[ $before == init.scope ]] && echo 1 || echo 2)); $MARKET_TABLE matched before and after restart"; fi
}

# ---------------------------------------------------------------- main
if ((dry_run)); then
  say "p0-rehearsal DRY-RUN: nothing is created, started, loaded or written"
  say "evidence directory (not created): $evidence_dir"
  selected P0.4 && p04_dry
  selected P0.5 && p05_dry
  selected P0.8 && p08_dry
  exit 0
fi

if [[ -e $evidence_dir ]]; then echo "p0-rehearsal: evidence directory already exists: $evidence_dir" >&2; exit 2; fi
mkdir -p "$(dirname "$evidence_dir")" && mkdir -m 0700 "$evidence_dir" || exit 2
{
  printf 'started_utc=%s\n' "$stamp"
  printf 'machine_id_sha256=%s\n' "$(sha256sum /etc/machine-id | cut -d' ' -f1)"
  printf 'kernel=%s\n' "$(uname -r)"
  printf 'systemd=%s\n' "$(systemctl --version | head -n1)"
  printf 'nft=%s\n' "$(nft --version 2>/dev/null || echo missing)"
  printf 'selected=%s\n' "$only"
} | redact >"$evidence_dir/host.txt"

say "p0-rehearsal: evidence in $evidence_dir"
selected P0.4 && p04_run
selected P0.5 && p05_run
selected P0.8 && p08_run

status=0
{
  printf 'probe\tresult\tdetail\n'
  for p in "${ORDER[@]}"; do printf '%s\t%s\t%s\n' "$p" "${RESULT[$p]}" "${DETAIL[$p]}"; done
} | redact >"$evidence_dir/summary.tsv"
for p in "${ORDER[@]}"; do
  case ${RESULT[$p]} in FAIL) status=1 ;; SKIP|BLOCKED) ((status == 1)) || status=3 ;; esac
done
case $status in
  0) say "p0-rehearsal: PASS (all selected probes passed)" ;;
  1) say "p0-rehearsal: FAIL (see $evidence_dir)" ;;
  3) say "p0-rehearsal: INCOMPLETE (a probe was skipped or blocked; this is not a pass)" ;;
esac
exit "$status"
