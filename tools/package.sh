#!/bin/sh
# =============================================================================
# package.sh — publish the built image for the browser flasher.
# -----------------------------------------------------------------------------
#     tools/package.sh
#
# Copies the images out of the build volume into firmware/dist/ and writes the
# manifest.json the flasher reads. Run after tools/build.sh.
#
# The build tree is a Docker volume rather than a directory, deliberately — see
# build.sh — so the copy has to happen inside a container that can see both it
# and the output directory. That is all this wrapper does; the thinking is in
# manifest.py next to it.
# =============================================================================
set -eu

IDF_IMAGE="espressif/idf:v5.3"
BUILD_VOL="openhardware-build"

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DIST="$ROOT/firmware/dist"

# Git Bash rewrites POSIX-looking paths in arguments before Docker sees them.
export MSYS_NO_PATHCONV=1

mkdir -p "$DIST"

docker run --rm \
  -v "$BUILD_VOL:/build:ro" \
  -v "$DIST:/out" \
  -v "$ROOT/tools:/tools:ro" \
  "$IDF_IMAGE" python3 /tools/manifest.py

cat <<EOF

Serve the repository root and the flasher will find it:

    python3 -m http.server 8000

    frontend  http://localhost:8000/frontend/
    manifest  http://localhost:8000/firmware/dist/manifest.json
EOF
