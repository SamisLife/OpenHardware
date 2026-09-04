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

## Reading a board back

```sh
pip install pyserial
../tools/monitor.py
```

The build tooling runs in the container. The monitor cannot: Docker has no view
of a host serial port. Nothing else may hold the port while it runs — a serial
port is exclusive machine-wide — which is deliberate, because taking the
browser out of the path is what makes the reading say something about this
firmware rather than about the whole stack.

## What is in the tree

| | |
|---|---|
| `harness/partitions.csv` | flash layout. The one thing here that cannot be changed later without re-flashing every board over a cable. |
| `harness/sdkconfig.defaults` | build configuration, each line a decision |
| `harness/sdkconfig` | generated, and committed — the record of what the shipped image was actually built with |
| `harness/main/` | the harness itself |
| `harness/components/hw_app_api/` | the public API an application may use |
| `apps/default/` | committed minimal application used only to create the known-safe baseline |
| `workspace/app/` | ignored mutable draft most recently submitted by an agent |
| `harness/components/app/` | generated compiler scratch space; never the canonical default |
| `baseline/` | ignored packaged factory image, created explicitly with `python tools/baseline.py` |
| `artifacts/<build-id>/` | ignored immutable candidate images and the exact sources that produced them |

### Baseline and candidate images

The harness version in `harness/version.txt` identifies the stable platform
and the wire and API contract. The app has its own name and version, so a
baseline is `harness <version> + app default 1.0`, and a candidate may carry
the same harness version with a different app and a different ELF hash. That
last case is the ordinary state of a board being worked on, not a mismatch:
the page names the application rather than comparing hashes.

With the build daemon stopped, `python tools/baseline.py` builds the committed
minimal app into `firmware/baseline/` and restores the mutable draft afterward.
Ordinary daemon builds are archived under a unique build id and contain only
the application image in their flash manifest. The page writes that image to
the inactive OTA slot, asks the running harness to validate its ELF identity,
then selects it. Factory is touched only by the explicit baseline recovery
path.

### The I²C boundary

ESP-IDF 5.3's umbrella `driver` component publicly exposes the new I²C API even
though `esp32-camera` links the mutually exclusive legacy driver. Calling the
new API pulls in a constructor that aborts before `app_main`, before the harness
can emit a frame. Header visibility is therefore not a sufficient guard.

The application component does not require `driver`; the local build daemon
also refuses new-I²C source names and inspects the final ELF for
`i2c_acquire_bus_handle`. That link-time inspection is the authority. The
legacy `driver/i2c.h` use in `main/hw_camera.c` belongs to the fixed harness and
must move with the camera driver when the project moves to IDF 5.4 or later.

## A note on `-v "$PWD:/project"`

Written as one quoted argument. Split as `-v "$PWD":/project` it works in bash
and fails in PowerShell with `invalid reference format`, because the colon ends
up outside the quotes and Docker can no longer tell where the volume
specification ends and the image name begins.
