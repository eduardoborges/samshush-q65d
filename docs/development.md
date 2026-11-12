# Development

## Checks

```sh
uv run --project tools ruff check tools
uv run --project tools ruff format --check tools
uv run --project tools python -m unittest discover -s tools/tests -v
node --test launcher/tests/*.test.cjs
```

The Python tests run the device scripts against a fake TV on the host. They cover
drift rejection, partial failure, rollback and transport quoting. They never
contact a TV, and they do not prove anything about real capture or a real boot.

## Layout

| Path | Contents |
| --- | --- |
| `tools/samshush.py` | The CLI. Renders device scripts and runs them through temporary root. |
| `tools/device_scripts.py` | Bash that runs on the TV. The TV needs no Python. |
| `tools/startup.py` | The startup hook and its control script. |
| `tools/launchpad.py`, `tools/launchpad_routing.py` | Shortcut Home packaging, install and Home assignment. |
| `tools/profiles/q65d-2123.json` | Every pinned app, unit, preimage and group for the supported build. |
| `tools/payload_sources.py` | C# sources for the TV helpers. |
| `tools/assets/` | Checksummed helper binaries. `SHA256SUMS.json` is checked before every command. |
| `tools/vendor/` | The pinned samsung-tv-root transport. Keep its bytes and license unchanged. |
| `launcher/` | The shortcut Home web app and its tests. |
| `.local/` (ignored) | SDB, private reports, signed widgets and build output. |

Runtime dependencies are the standard library plus the vendored transport. Add
new ones only on purpose. `mise.toml` pins the toolchain; keep its Python inside
the `requires-python` range in `tools/pyproject.toml`. uv uses that Python and
never downloads its own. Never add a generic command that runs arbitrary shell on
the TV.

## TV helpers

`build_payloads.py` rebuilds the .NET helpers into a fresh directory with the
`dotnet` on `PATH`, which has to be SDK 6.0.428 (mise installs it), and compares
them with the checked-in binaries. `--dotnet` points it at another copy of the
same SDK. It never deploys anything, and the prebuilt assets don't need .NET on
the host. The routing transaction tests build the same helper and are skipped
when that SDK is missing.

```sh
uv run --project tools tools/build_payloads.py --output .local/payload-build-NEW
```

The routing helper writes its build into the Home recovery receipt, so each build
has its own binary under `tools/assets/payloads/PROFILE`. It comes from the same
source with only the build constant changed. Never point a profile at another
build's helper or edit that constant by hand.

## A new firmware build

A firmware update needs a new profile, for example
`tools/profiles/q65d-NNNN.json`, registered in `PROFILES` in `samshush.py`. Don't
copy the old profile and change its build string. For the new build:

1. Read the live executables, manifests and unit files and pin their hashes as
   preimages.
2. Run the native trial on one component (disable, read back, check launch
   denial, restore) before any batch.
3. Check each optional group against `service-audit` before adding it.
4. Build its routing helper, add it under `tools/assets/payloads/NEW-PROFILE`
   and add both files to `SHA256SUMS.json`.
5. Update [controls.md](controls.md) and [status.md](status.md) with what was
   actually verified.

[agent-prompt.md](agent-prompt.md) is the full method for an agent doing this
work.
