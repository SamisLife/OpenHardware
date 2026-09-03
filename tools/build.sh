#!/bin/sh
# =============================================================================
# build.sh — build the harness image.
# -----------------------------------------------------------------------------
# Nothing is installed on the host. The toolchain is a pinned container and the
# build tree is a Docker volume, so the only requirement is Docker itself.
#
#     tools/build.sh              incremental
#     tools/build.sh --clean      from scratch
#
# This exists rather than a documented docker line for three reasons, each of
# which cost real time to learn.
# =============================================================================
set -eu

IDF_IMAGE="espressif/idf:v5.3"
TARGET="esp32s3"

BUILD_VOL="openhardware-build"
CCACHE_VOL="openhardware-ccache"

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
HARNESS="$ROOT/firmware/harness"

# The compiler component is scratch space. A fresh clone has no generated app
# source yet, so a direct build starts from the committed minimal baseline.
if ! ls "$HARNESS/components/app/"*.c >/dev/null 2>&1; then
  cp "$ROOT/firmware/apps/default/app.c" "$HARNESS/components/app/app.c"
fi

# -----------------------------------------------------------------------------
# REASON ONE: set-target runs fullclean first.
#
# `idf.py set-target esp32s3` is not a configuration tweak — it wipes the build
# directory and starts over. Measured here: 194.7 s against 4.1 s for the
# incremental build it replaced. Leaving it in the loop, which is the obvious
# thing to do because it looks idempotent, rebuilds all 1012 objects for a
# one-line change.
#
# So it runs only when the build tree does not already agree with the target,
# and that condition is checked rather than assumed.
# -----------------------------------------------------------------------------
CLEAN=0
[ "${1:-}" = "--clean" ] && CLEAN=1

# -----------------------------------------------------------------------------
# REASON TWO: the build directory must not live in the repository.
#
# This tree sits inside a synced folder. A build writes on the order of a
# thousand object files, every one of which the sync client then queues for
# upload, and the first measurement of that here was roughly ONE OBJECT PER
# SECOND — a 35-second build taking over an hour, with no error anywhere to
# explain it.
#
# Mounting a Docker volume over /project/build keeps the output off the synced
# filesystem entirely. Same source, same container, same command: 34.7 s.
# -----------------------------------------------------------------------------

# -----------------------------------------------------------------------------
# REASON THREE: Git Bash rewrites paths that look like POSIX ones.
#
# On Windows, MSYS helpfully converts the `/project` in `-v ...:/project` into
# a Windows path before Docker ever sees it, and the error that comes back
# talks about an invalid working directory rather than about path conversion.
# MSYS_NO_PATHCONV turns that off; it is ignored everywhere else.
# -----------------------------------------------------------------------------
export MSYS_NO_PATHCONV=1

idf() {
  docker run --rm \
    -v "$HARNESS:/project" \
    -v "$BUILD_VOL:/project/build" \
    -v "$CCACHE_VOL:/root/.ccache" \
    -w /project "$IDF_IMAGE" \
    idf.py "$@"
}

# Has this build tree ever been targeted, and at the right chip? Asking the
# build tree beats keeping a flag file next to it, which would be one more
# thing that can be true while the tree says otherwise.
targeted=$(docker run --rm -v "$BUILD_VOL:/b" "$IDF_IMAGE" \
  sh -c "grep -m1 '^CONFIG_IDF_TARGET=' /b/../sdkconfig 2>/dev/null || \
         grep -m1 'IDF_TARGET' /b/CMakeCache.txt 2>/dev/null || true" 2>/dev/null | tr -d '\r')

if [ "$CLEAN" -eq 1 ]; then
  echo "==> fullclean, then set-target $TARGET"
  idf fullclean || true
  idf set-target "$TARGET"
elif ! printf '%s' "$targeted" | grep -q "$TARGET"; then
  echo "==> build tree has no target yet; set-target $TARGET (this wipes and rebuilds)"
  idf set-target "$TARGET"
else
  echo "==> target already $TARGET; incremental build"
fi

# A note on the version, because it is read at CONFIGURE time and not at build
# time. Once version.txt exists CMake tracks it and re-runs itself when it
# changes, so editing it is enough. CREATING it is not: CMake cannot depend on
# a file that did not exist the last time it ran, so the first build after
# adding one keeps the old version, and every artefact published from it is
# mislabelled with nothing anywhere reporting a problem. `--clean` fixes it,
# and so does `idf.py reconfigure`.

idf build

echo
echo "==> built. tools/package.sh publishes it."
