#!/usr/bin/env bash
# Build the instance image from a packed Harness CLI. Usage: build-image.sh <dsh.tgz> <image-ref>
set -euo pipefail
tarball=${1:?packed dsh tarball}; image=${2:?image reference}
cd "$(dirname "$0")/.."
cp "$tarball" ./dsh.tgz
trap 'rm -f ./dsh.tgz' EXIT
podman build --file Containerfile --build-arg DSH_TARBALL=dsh.tgz --tag "$image" .
