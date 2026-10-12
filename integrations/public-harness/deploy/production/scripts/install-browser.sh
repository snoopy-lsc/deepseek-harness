#!/usr/bin/env bash
# Install or verify the pinned Chrome for Testing build at a fixed root-owned path.
#   install-browser.sh install <browser-root> [local-zip]   download (or take local-zip), check SHA-256, install
#   install-browser.sh verify <browser-root>                 check pin record, file digests, ownership and version
# <browser-root> must match native.paths.browserRoot; the executable is <browser-root>/chrome-linux64/chrome.
# Nothing here weakens the browser sandbox or loads policy; the runtime's AppArmor child profile confines the binary.
set -euo pipefail

pin_file=${DSH_BROWSER_PIN:-"$(dirname "$(readlink -f "$0")")/../browser.pin"}
fail() { echo "install-browser: $*" >&2; exit 1; }
[[ $# -ge 2 ]] || fail "usage: $0 install|verify <browser-root> [local-zip]"
action=$1 root=$2
[[ $root == /* && $root != */ && $root != *..* && $root =~ ^/[A-Za-z0-9_./-]+$ ]] || fail "browser root must be a plain absolute path"

version= url= sha=
while IFS='=' read -r key value; do
  case $key in
    CFT_VERSION) version=$value ;; CFT_URL) url=$value ;; CFT_SHA256) sha=$value ;;
    ''|'#'*) ;; *) fail "unknown pin key: $key" ;;
  esac
done < "$pin_file"
[[ $version =~ ^[0-9]+(\.[0-9]+){3}$ ]] || fail "pinned version is invalid"
[[ $sha =~ ^[0-9a-f]{64}$ ]] || fail "pinned SHA-256 is invalid"
[[ $url == "https://storage.googleapis.com/chrome-for-testing-public/$version/linux64/chrome-linux64.zip" ]] || fail "pinned URL does not match the version"

verify() {
  local dir=$1
  [[ -f $dir/.dsh-browser-pin && ! -L $dir/.dsh-browser-pin ]] || fail "missing pin record in $dir"
  [[ $(cat "$dir/.dsh-browser-pin") == "$version $sha" ]] || fail "installed build is not the pinned build"
  local bad
  bad=$(find "$dir" \( ! -user 0 -o ! -group 0 -o -perm /022 \) -print -quit)
  [[ -z $bad ]] || fail "not root-owned or writable by others: $bad"
  (cd "$dir" && sha256sum --quiet --strict -c .dsh-browser-files.sha256) || fail "installed files differ from the install record"
  local listed actual
  listed=$(cut -c67- "$dir/.dsh-browser-files.sha256" | sort)
  actual=$(cd "$dir" && find . -type f ! -name '.dsh-browser-*' | sort)
  [[ $listed == "$actual" ]] || fail "installed tree has files outside the install record"
  [[ -z $(find "$dir" ! -type f ! -type d -print -quit) ]] || fail "installed tree contains links or special files"
  local reported
  reported=$("$dir/chrome-linux64/chrome" --version 2>/dev/null) || fail "browser does not run"
  [[ $reported == "Google Chrome for Testing $version"* ]] || fail "browser reports '$reported', expected $version"
}

case $action in
  verify) verify "$root"; echo "install-browser: $root holds Chrome for Testing $version" ;;
  install)
    work=$(mktemp -d) staging=; trap 'rm -rf "$work" ${staging:+"$staging"}' EXIT
    zip=${3:-}
    if [[ -z $zip ]]; then curl -fsSL --proto '=https' --tlsv1.2 -o "$work/chrome.zip" "$url"; zip=$work/chrome.zip; fi
    echo "$sha  $zip" | sha256sum --quiet --strict -c - || fail "checksum mismatch for $zip; nothing installed"
    [[ $(id -u) == 0 ]] || fail "install must run as root"
    staging=$(mktemp -d "$root.new.XXXXXX")
    # Extract regular files and directories only, keeping the archive's executable bits and refusing links or escapes.
    python3 - "$zip" "$staging" <<'PY'
import os, stat, sys, zipfile
archive, target = sys.argv[1], os.path.realpath(sys.argv[2])
with zipfile.ZipFile(archive) as z:
    for info in z.infolist():
        mode = info.external_attr >> 16
        path = os.path.realpath(os.path.join(target, info.filename))
        if not path.startswith(target + os.sep) or (mode and not (stat.S_ISREG(mode) or stat.S_ISDIR(mode))):
            sys.exit(f"refusing archive entry {info.filename!r}")
        if info.is_dir():
            os.makedirs(path, exist_ok=True); continue
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with z.open(info) as src, open(path, 'xb') as dst:
            while chunk := src.read(1 << 20): dst.write(chunk)
        os.chmod(path, 0o755 if mode & 0o111 else 0o644)
PY
    [[ -x $staging/chrome-linux64/chrome ]] || fail "archive has no chrome-linux64/chrome"
    chown -R 0:0 "$staging" && chmod -R u+rwX,go+rX,go-w "$staging"
    (cd "$staging" && find . -type f | sort | xargs -d '\n' sha256sum) > "$work/files.sha256"
    mv "$work/files.sha256" "$staging/.dsh-browser-files.sha256"
    echo "$version $sha" > "$staging/.dsh-browser-pin"
    chmod 0644 "$staging/.dsh-browser-files.sha256" "$staging/.dsh-browser-pin"
    verify "$staging"
    if [[ -e $root ]]; then mv -T "$root" "$root.previous.$(date +%Y%m%d%H%M%S)"; fi
    mv -T "$staging" "$root"; staging=
    verify "$root"
    echo "install-browser: installed Chrome for Testing $version at $root" ;;
  *) fail "unknown action: $action" ;;
esac
