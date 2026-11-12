# Samshush agent guide

This fork supports one TV: Samsung QN55Q65DAGXZD, Tizen 9, ARMv7, build
`T-NKLDUABC-0090-REL-202603190159` (menu firmware 2123.9), profile `q65d-2123`.
The CLI is `tools/samshush.py`; `--help` is the command reference.

## Scope

Help the owner turn off microphone capture and always-on listening with the
strongest reversible controls this build supports. Implement only the requested
scope. An audit or research request does not authorize changes on the TV.
Advertising, telemetry and app groups are separate opt-in scopes, and so are the
startup hook and the shortcut Home. The controls in [docs/controls.md](docs/controls.md)
are recommendations, not permission to apply all of them.

Preserve Settings, remote navigation, HDMI and CEC (the soundbar sits on HDMI 2),
playback, audio output, networking, DRM, manual updates, the browser and the
streaming apps. Never flash or downgrade firmware or install a persistent root
hook outside the `startup` command.

## Before touching the TV

1. Read `tools/profiles/q65d-2123.json` and, when present,
   `.local/reports/current-state.json`. Historical evidence is not current state.
2. Find the TV through existing records, ARP, mDNS or SSDP. Confirm the model and
   build, and the host address that routes to it. SDB accepts only the address
   entered in Developer Mode ([troubleshooting](docs/troubleshooting.md)).
3. Run `mise install` and `uv sync --project tools --locked`, then
   `samshush.py doctor`. Reuse the existing SDB and OpenSSL installations.
4. Every TV command acquires temporary root, including `inspect`, `status` and the
   audits. Say so before running one.

Never bypass a build or preimage check, and never edit a build string to support
another firmware. A new build needs a new profile, a native trial and new pins
([docs/development.md](docs/development.md#a-new-firmware-build)).

## Rules on the TV

- The voice shutdown order is in [docs/commands.md](docs/commands.md#voice-shutdown).
  Each optional group applies its app flags before its services.
- Journals under `/run/frame-*`, `/opt/usr/home/owner/share/frame-*` and
  `/opt/usr/share/samshush-*` are recovery records. Never delete a journal or a
  stale lock to force an apply, and never rename the `frame-` paths: the TV
  already holds journals under them.
- A timeout means the outcome is unknown. Inspect before retrying, and never start
  a second root operation while the first may still be cleaning up.
- Run `startup remove` before restoring any control or changing the enrolled
  groups. Follow the restore order in [docs/commands.md](docs/commands.md#recovery).
- On build or preimage drift, or an unhealthy service manager, stop changing
  things and recover first.
- Never edit systemd's generated unit cache. A temporary experiment with it in the
  original project stalled PID 1. Never delete vendor units, edit package
  databases or opaque caches.
- Do not record audio or capture network packets. A quiet audit or a failed wake
  word does not prove that capture is denied.
- `optional-delivery` turns off automatic app updates. Get the owner's explicit
  acceptance before applying it.
- Never enroll the Home assignment in the startup hook.

## Proving an outcome

Check native flags, process absence by exact executable or DLL, service and
trigger state, and direct launch denial separately. A stopped unit is not enough
when the app manager can start the executable.

For persistence, save the boot ID, reboot with a supported method, require a
changed boot ID, and read `startup status` plus each group's status before any
apply from the computer. A passing `startup run` is not a reboot test. A software
reboot is not a power cycle, and neither proves survival across a firmware update.

Label what the owner observed separately from what the tools verified. After live
work, update `.local/reports/current-state.json` with timestamps, per-control
evidence, recovery commands and gaps.

## Docs

| File | Owns |
| --- | --- |
| `README.md` | Initial setup only. Keep it short. |
| `docs/controls.md` | The controls table. Update it whenever a finding or recommendation changes. |
| `docs/commands.md` | Command reference, boot reapplication and recovery order. |
| `docs/status.md` | Verified evidence and open gaps on the TV. |
| `docs/home-screen.md` | The shortcut Home. |
| `docs/how-it-works.md`, `docs/troubleshooting.md`, `docs/development.md` | Background, fixes and development. |
| `docs/agent-prompt.md` | The full method for validating a build. |

Keep the profile, scripts, tests and these docs in sync when behavior changes.
Keep forensic evidence and open investigations in ignored local reports. Never put
IP addresses, the TV's name, its DUID, postcodes or raw logs in tracked files.

## Development

Take the toolchain from `mise.toml`. Run the checks in
[docs/development.md](docs/development.md) before committing. Host tests use a fake
TV; never contact the TV to check formatting or docs. Keep vendored bytes
unchanged, and never add a command that runs arbitrary shell on the TV.

Finish with the actual changes, evidence, persistence scope and remaining gaps.
Keep prepared artifacts separate from applied controls.
