"""
manifest.py — publish a built image, and describe it truthfully.

Runs inside the toolchain container, where the build volume is mounted. It
copies the images a board actually needs out of the build tree and writes the
manifest the browser flasher reads.

Two ideas do all the work here.

FLASHER_ARGS IS THE AUTHORITY ON WHAT GOES WHERE
    Offsets are not written down in this file. ESP-IDF emits flasher_args.json
    describing exactly which images the build produced and where each belongs,
    derived from partitions.csv — so a change to the partition table travels
    through to the manifest on its own. Hardcoding 0x20000 here would work
    until the day the table moved, and then it would write an application over
    a partition table with no error at any step.

THE MANIFEST DESCRIBES THE IMAGE, NOT THE INTENT
    Version, project name, IDF version and the ELF hash are read out of the
    binary's own app descriptor rather than passed in. A board reports those
    same bytes over the wire at boot, so "is this board running the image that
    was published" becomes a comparison rather than an assumption. Anything
    taken from a variable instead could describe an image nobody is running.
"""

import hashlib
import json
import os
import shutil
import struct
import sys

BUILD = '/build'
OUT = '/out'

# esp_app_desc_t sits immediately after the 24-byte image header and the
# 8-byte header of its first segment.
APP_DESC_OFFSET = 0x20
APP_DESC_MAGIC = 0xABCD5432

# Field offsets within esp_app_desc_t, from esp_app_desc.h.
F_VERSION, F_PROJECT, F_TIME, F_DATE, F_IDF, F_ELF_SHA = 16, 48, 80, 96, 112, 144


def read_app_desc(path):
    """What the image says about itself, or None if it is not an application."""
    with open(path, 'rb') as f:
        head = f.read(APP_DESC_OFFSET + 256)

    if len(head) < APP_DESC_OFFSET + F_ELF_SHA + 32:
        return None

    (magic,) = struct.unpack_from('<I', head, APP_DESC_OFFSET)
    if magic != APP_DESC_MAGIC:
        # A bootloader or a partition table. Perfectly normal — only the
        # application carries a descriptor.
        return None

    def text(off, size):
        raw = head[APP_DESC_OFFSET + off:APP_DESC_OFFSET + off + size]
        return raw.split(b'\0')[0].decode('utf-8', 'replace')

    sha = head[APP_DESC_OFFSET + F_ELF_SHA:APP_DESC_OFFSET + F_ELF_SHA + 32]
    return {
        'version': text(F_VERSION, 32),
        'project': text(F_PROJECT, 32),
        'idf': text(F_IDF, 32),
        'built': '%s %s' % (text(F_DATE, 16), text(F_TIME, 16)),
        # The same eight bytes a board puts in its hello frame.
        'elf_sha8': sha[:8].hex(),
    }


def main():
    args_path = os.path.join(BUILD, 'flasher_args.json')
    if not os.path.exists(args_path):
        sys.exit('no flasher_args.json in the build tree — run tools/build.sh first')

    with open(args_path) as f:
        flasher = json.load(f)

    flash_files = flasher.get('flash_files') or {}
    if not flash_files:
        sys.exit('flasher_args.json lists no images')

    os.makedirs(OUT, exist_ok=True)

    # Everything the previous publish left behind goes first. A stale image
    # alongside a fresh manifest is worse than no image: the manifest names
    # only what it knows about, and whatever else is sitting in the directory
    # looks equally published to anyone browsing it.
    for name in os.listdir(OUT):
        path = os.path.join(OUT, name)
        os.remove(path) if os.path.isfile(path) else shutil.rmtree(path)

    parts = []
    described = None

    # Sorted by offset so the manifest reads in flash order rather than in
    # whatever order a JSON object happened to serialise.
    for offset_s, rel in sorted(flash_files.items(), key=lambda kv: int(kv[0], 16)):
        src = os.path.join(BUILD, rel)
        if not os.path.exists(src):
            sys.exit('%s is listed in flasher_args.json but was not built' % rel)

        # Flattened. The nesting is a build-tree detail, and a flat directory
        # is one the browser can fetch from without the server having to
        # reproduce the layout.
        name = os.path.basename(rel)
        dst = os.path.join(OUT, name)
        shutil.copyfile(src, dst)

        data = open(dst, 'rb').read()
        parts.append({
            'path': name,
            'offset': int(offset_s, 16),
            'size': len(data),
            # sha256, not the md5 esptool would give. WebCrypto has no md5 at
            # all, so a manifest carrying one could not be verified in a
            # browser without shipping an implementation to do it — and an
            # image nobody can verify is one nobody can say arrived intact.
            'sha256': hashlib.sha256(data).hexdigest(),
        })

        desc = read_app_desc(dst)
        if desc:
            described = desc

    if described is None:
        sys.exit('none of the built images carries an app descriptor')

    total = sum(p['size'] for p in parts)

    manifest = {
        'version': described['version'],
        'project': described['project'],
        'chip': (flasher.get('extra_esptool_args') or {}).get('chip', ''),
        'idf': described['idf'],
        'built': described['built'],
        # What a board will report in its hello frame. Published so that
        # "running the image that was flashed" is checkable rather than assumed.
        'elf_sha8': described['elf_sha8'],
        'flash': flasher.get('flash_settings') or {},
        # Derived from the images rather than declared. A flasher showing how
        # much it is about to write should be summing what it will actually
        # write, and a figure typed in somewhere else is one that can be wrong.
        'total_bytes': total,
        'parts': parts,
    }

    with open(os.path.join(OUT, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=2)
        f.write('\n')

    print('published %s %s (%s, idf %s)'
          % (manifest['project'], manifest['version'], manifest['chip'], manifest['idf']))
    print('built %s, elf sha %s' % (manifest['built'], manifest['elf_sha8']))
    print()
    for p in parts:
        print('  0x%06x  %-28s %7d bytes  %s' % (p['offset'], p['path'], p['size'],
                                                 p['sha256'][:16]))
    print()
    print('  %d images, %d bytes total' % (len(parts), total))


if __name__ == '__main__':
    main()
