#!/usr/bin/env python3
"""Build the explicit known-safe factory image without changing the draft.

Run with the build daemon stopped. The minimal committed application is copied
to the compiler scratch component, built and packaged into firmware/baseline,
then the current draft is restored to the scratch component.
"""

from __future__ import annotations

import json
from pathlib import Path
import shutil
import sys
import tempfile

import buildd


def checked(command: list[str]) -> None:
    result = buildd.run_command(command)
    sys.stdout.write(result.stdout or "")
    if result.returncode:
        raise SystemExit(result.returncode)


def remove_tree(path: Path) -> None:
    """Remove a directory on a filesystem that says no the first time.

    A synced folder holds files open for moments at a time and marks some of
    them read-only, and either answer makes rmtree raise on Windows. Clearing
    the attribute and trying again a few times is what it takes; the caller
    treats what is left after that as a warning rather than a failure, because
    the new baseline is already in place by then.
    """
    import os
    import stat
    import time

    def clear(func, target, _exc):
        os.chmod(target, stat.S_IWRITE)
        func(target)

    for attempt in range(5):
        try:
            shutil.rmtree(path, onerror=clear)
            return
        except OSError:
            if attempt == 4:
                raise
            time.sleep(1.0)


def publish(temp: Path, dest: Path) -> None:
    """Put the new baseline in place without ever leaving no baseline at all.

    The old tree is moved aside and the new one moved in, so at every instant
    a directory named `baseline` exists with a complete image in it. The old
    tree is removed last and its removal is allowed to fail: a stale copy under
    another name costs disk space, an absent baseline costs the one recovery
    path the board has.
    """
    fresh = dest.with_name(dest.name + ".new")
    stale = dest.with_name(dest.name + ".old")
    for leftover in (fresh, stale):
        if leftover.exists():
            remove_tree(leftover)
    shutil.copytree(temp, fresh)
    if dest.exists():
        dest.rename(stale)
    fresh.rename(dest)
    if stale.exists():
        try:
            remove_tree(stale)
        except OSError as err:
            print(f"warning: the previous baseline could not be removed ({err}); it is at {stale}")


def main() -> None:
    files = buildd.source_files(buildd.DEFAULT_APP_DIR)
    clean, error = buildd.validate_files(files)
    if error:
        raise SystemExit(f"invalid baseline source: {error}")

    draft = buildd.read_sources()
    buildd.write_scratch(clean)
    try:
        checked([buildd.bash_path(), "tools/build.sh"])
        checked([buildd.bash_path(), "tools/package.sh"])

        manifest = json.loads((buildd.DIST / "manifest.json").read_text(encoding="utf-8"))
        name, version = buildd.app_identity(clean)
        manifest.update({
            "kind": "baseline",
            "build_id": f"baseline-{manifest.get('version', 'unknown')}",
            "app": {"name": name, "version": version, "sha": buildd.source_sha(clean)},
        })

        firmware_root = buildd.ROOT / "firmware"
        with tempfile.TemporaryDirectory(prefix="baseline-", dir=firmware_root) as temp_name:
            temp = Path(temp_name)
            for path in buildd.DIST.iterdir():
                if path.is_file():
                    shutil.copy2(path, temp / path.name)
            source = temp / "source"
            source.mkdir()
            for file_name, content in clean.items():
                (source / file_name).write_text(content, encoding="utf-8", newline="\n")
            (temp / "manifest.json").write_text(
                json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n"
            )
            publish(temp, buildd.BASELINE)
        print(f"baseline published at {buildd.BASELINE}")
    finally:
        if draft:
            buildd.write_scratch(draft)


if __name__ == "__main__":
    main()
