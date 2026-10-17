#!/usr/bin/env bash
# Assemble one immutable runtime-assets release (mounted read-only into every instance) from built packages.
# Usage: build-assets.sh <integration-root> <releases-dir> <release-id>
set -euo pipefail
root=${1:?integration root}; releases=${2:?releases dir}; release=${3:?release id}
[[ $release =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || { echo "invalid release id" >&2; exit 2; }
dest="$releases/$release"
[[ ! -e $dest ]] || { echo "release already exists: $release" >&2; exit 2; }
mkdir -p "$dest/packages"
cp "$root/packages/provisioner/lib/container-entry.js" "$root/packages/provisioner/lib/sidecar.js" "$dest/"
for package in web-token quota-provider ui; do
  [[ -f $root/packages/$package/lib/index.js ]] || { echo "build $package first" >&2; exit 2; }
  mkdir -p "$dest/packages/$package"
  cp -R "$root/packages/$package/lib" "$root/packages/$package/package.json" "$dest/packages/$package/"
done
# Read-only knowledge base skills (kb-query, kb-author), added to instances through customSkillDirs when knowledge bases are enabled.
mkdir -p "$dest/packages/kb"
cp -R "$root/packages/kb/skills" "$dest/packages/kb/"
# Resolved inside the container (the target exists only in the image), so plugins find their dependencies.
ln -s /opt/dsh/node_modules "$dest/node_modules"
chmod -R a-w,a+rX "$dest"
echo "$dest"
