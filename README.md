# Samshush for the Samsung Q65D

Turn off voice assistants, always-on listening, ads and background telemetry on a
Samsung QN55Q65DAGXZD running firmware 2123.9 (build
`T-NKLDUABC-0090-REL-202603190159`). Samshush gets temporary root over the local
network, saves the original state, and blocks selected apps and services. Every
change has a restore command. An optional full-screen shortcut app can replace
Samsung Home.

This is a fork of [elithrar/samshush](https://github.com/elithrar/samshush),
narrowed to this one TV and build. Every TV command checks the exact build and
refuses anything else. Turn off Auto Update on the TV: a firmware update stops
the tools from working and may patch the root exploit.

## Requirements

- macOS or Linux on the same LAN as the TV, preferably on one interface (see
  [troubleshooting](docs/troubleshooting.md))
- [uv](https://docs.astral.sh/uv/) and Python 3.12 or 3.13
- Samsung's `sdb`, which ships with Tizen Studio
- OpenSSL
- Node.js, only to run the launcher tests

## Initial setup

1. Enable Developer Mode. On the TV, open Apps, then App Settings, enter
   `12345`, turn on Developer Mode, enter your computer's LAN address and reboot
   the TV. See
   [Samsung's guide](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-device.html)
   if the menus differ.

2. Clone the fork and install the Python environment.

   ```sh
   git clone https://github.com/eduardoborges/samshush.git
   cd samshush
   uv sync --project tools --locked
   ```

3. Check the local tools. `doctor` never contacts the TV. If `sdb` is not on
   your `PATH`, pass `--sdb /path/to/sdb` or set `SDB`.

   ```sh
   uv run --project tools tools/samshush.py doctor
   ```

4. Point the CLI at the TV, using the TV's address and the computer address you
   entered in Developer Mode:

   ```sh
   export TV=192.0.2.10 HOST=192.0.2.20
   alias samshush='uv run --project tools tools/samshush.py --tv "$TV" --callback-host "$HOST"'
   samshush inspect
   ```

   `inspect` refuses to go on if the model or build differs. Even read-only
   commands acquire temporary root on the TV.

5. Turn off voice. Run these in order and read each report in `.local/reports`
   before the next step:

   ```sh
   samshush compatibility-audit
   samshush voice-audit
   samshush apps trial
   samshush apps apply
   samshush apply --scope voice
   samshush sound-sensor apply
   samshush apps verify
   samshush status
   ```

6. Pick the optional groups. Ads, reporting, presence sensing and the rest each
   have their own journal and tradeoffs. Read [controls](docs/controls.md)
   first, then follow [commands](docs/commands.md#voice-shutdown).

7. Optionally, keep the service masks across reboots. They last one boot, and
   the startup hook reapplies them on the TV:
   [automatic boot reapplication](docs/commands.md#automatic-boot-reapplication).

You can also hand the repository to a coding agent. It should read
[AGENTS.md](AGENTS.md) first.

## Undo

Remove the startup hook first, then restore each layer:

```sh
samshush startup remove
samshush restore
samshush apps restore
samshush sound-sensor restore
```

Optional groups have their own restore commands; see
[recovery](docs/commands.md#recovery).

## Documentation

| Page | Contents |
| --- | --- |
| [controls](docs/controls.md) | Every control, what it blocks and what you lose |
| [commands](docs/commands.md) | Command reference, boot reapplication and recovery |
| [home screen](docs/home-screen.md) | The optional shortcut Home: build, sign, install, update, restore |
| [how it works](docs/how-it-works.md) | Root access, journals and persistence |
| [status](docs/status.md) | What has been verified on the TV and what is still open |
| [troubleshooting](docs/troubleshooting.md) | SDB connection problems, timeouts, standby |
| [development](docs/development.md) | Tests, TV helpers and supporting a new firmware build |
| [agent prompt](docs/agent-prompt.md) | Full method for an agent working on the TV |

## License and credits

[BSD 3-Clause](LICENSE) for project code and documentation. See [NOTICE](NOTICE)
for third-party code, device payloads and data sources.

Samshush was created by Matt Silverlock ([elithrar/samshush](https://github.com/elithrar/samshush)).
The root transport comes from
[chris-ritsen/samsung-tv-root](https://github.com/chris-ritsen/samsung-tv-root).
