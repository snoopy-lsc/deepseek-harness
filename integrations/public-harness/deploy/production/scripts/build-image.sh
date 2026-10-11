#!/usr/bin/env bash
# Build the instance image from a packed Harness CLI and export it for the provisioner.
# Usage: build-image.sh <dsh.tgz> <image-ref> [archive]
# The archive (default /opt/dsh-public/image/dsh-instance.tar) is what each instance account loads into its own
# rootless store on first start (`imageArchive` in provisioner.json). It must be readable by every account.
set -euo pipefail
tarball=${1:?packed dsh tarball}; image=${2:?image reference}; archive=${3:-/opt/dsh-public/image/dsh-instance.tar}
cd "$(dirname "$0")/.."
cp "$tarball" ./dsh.tgz
trap 'rm -f ./dsh.tgz' EXIT
podman build --file Containerfile --build-arg DSH_TARBALL=dsh.tgz --tag "$image" .
install -d -m 0755 "$(dirname "$archive")"
podman save --format docker-archive --output "$archive.tmp" "$image"
chmod 0644 "$archive.tmp"
mv "$archive.tmp" "$archive"
