# firmware

The harness: the fixed firmware layer a board runs, and the layer an agent is
never permitted to edit. Whatever an agent generates is compiled alongside it,
so however wrong that code is, telemetry still comes back to say so.

## Building

ESP-IDF v5.3 in Docker. Nothing is installed on the host.

```sh
docker run --rm \
  -v "$PWD/harness:/project" \
  -v openhardware-build:/project/build \
  -v openhardware-ccache:/root/.ccache \
  -w /project espressif/idf:v5.3 \
  idf.py build
```

`set-target esp32s3` is needed once, and only once — it runs `fullclean` first,
so leaving it in the loop rebuilds every object for a one-line change. The
tooling that decides which of the two to run lands with the build scripts.

### Two volumes, and why

**`openhardware-build` holds the build directory.** A build writes on the order
of a thousand object files, and this repository lives inside a synced folder.
Every one of those writes then queues a file for upload, and the first
measurement of it here was roughly **one object per second against a hundred
times that** — a three-minute build taking most of an hour. Mounting a Docker
volume over `/project/build` keeps the output off the synced filesystem
entirely. The source is still bind-mounted, so edits are picked up normally.

**`openhardware-ccache` holds the compiler cache.** A `--rm` container throws
its filesystem away on exit, so without this even a rebuild of unchanged code
starts from nothing.

Neither volume holds anything that is not reproducible from source. To start
completely clean:

```sh
docker volume rm openhardware-build openhardware-ccache
```

## What is in the tree

| | |
|---|---|
| `harness/partitions.csv` | flash layout. The one thing here that cannot be changed later without re-flashing every board over a cable. |
| `harness/sdkconfig.defaults` | build configuration, each line a decision |
| `harness/sdkconfig` | generated, and committed — the record of what the shipped image was actually built with |
| `harness/main/` | the harness itself |

## A note on `-v "$PWD:/project"`

Written as one quoted argument. Split as `-v "$PWD":/project` it works in bash
and fails in PowerShell with `invalid reference format`, because the colon ends
up outside the quotes and Docker can no longer tell where the volume
specification ends and the image name begins.
