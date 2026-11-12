# Commands and recovery

Run everything from the repository root. Connection options go before the
command. The examples use a shell alias:

```sh
export TV=192.0.2.10 HOST=192.0.2.20   # the TV and this computer on the LAN
alias samshush='uv run --project tools tools/samshush.py --tv "$TV" --callback-host "$HOST"'
```

`samshush.py --help` lists every command. Each TV command acquires temporary
root, including the audits and `status`, and writes a report to
`.local/reports`. Those reports hold device identifiers, so keep them out of Git
and Gists.

## Reference

| Command | What it does |
| --- | --- |
| `doctor` | Checks local tools and payload checksums. Does not contact the TV. |
| `plan` | Prints the profile. Does not contact the TV. |
| `inspect` | Reports identity, mount namespace and the state of the targeted units. |
| `compatibility-audit` | Reads firmware identity, voice registrations, activation files and startup preimages. |
| `voice-audit` | Lists voice processes and capture metadata. Records no audio. |
| `privacy-audit` | Reads SmartThings sensor flags, sound settings, Wi-Fi presence and ACR units. |
| `service-audit` | Reads every service and unit file, app registrations and process identities. Launches nothing. |
| `debloat-audit` | Reads optional-app registrations, dependencies and process identities. |
| `hdmi-audit` | Reads Anynet+/CEC settings and connected devices. Sends no CEC commands. |
| `network-audit` | Reads Wi-Fi radio power, Ethernet state and link speed. |
| `apps trial` | Disables, checks and restores one voice app. The batch apply refuses to run until this trial has passed. |
| `apps apply/status/verify/restore` | Native flags for the 23 voice apps, with a persistent journal. `verify` attempts real launches, so a failure may start an app. |
| `apps ... --group GROUP` | The same for an app group: `advertising`, `remote-pc`, `gaming-backend` or `optional-delivery`. |
| `sound-sensor apply/status/verify/restore` | Blocks `ambient-sound` under its own journal. |
| `apply --scope voice` | Masks and stops the 19 voice units for this boot. |
| `services GROUP apply/status/restore` | Masks a service group for this boot: `wifi-presence`, `advertising`, `reporting`, `presence-sensing`, `analytics-context`, `remote-support`, `remote-pc`, `gaming-backend` or `optional-delivery`. |
| `status` | Checks this boot's voice masks. No journal means nothing was recorded, not that the TV is protected. |
| `restore` | Removes the voice masks and restarts units that were running before. |
| `guards-apply` | Installs vendor startup guards. This build has none, so it is not needed. |
| `startup audit/probe/install/status/run/remove` | Automatic boot reapplication, described below. |
| `launchpad ...` | The optional [shortcut Home](home-screen.md). |

## Voice shutdown

On a TV that has never been changed, run these in order and read each report
before the next step:

```sh
uv run --project tools tools/samshush.py doctor
samshush inspect
samshush compatibility-audit
samshush voice-audit          # saves the before state
samshush apps trial
samshush apps apply
samshush apply --scope voice
samshush sound-sensor apply
samshush apps verify
samshush status
samshush voice-audit
```

Each optional group needs its app flags before its services. For example:

```sh
samshush apps apply --group advertising
samshush services advertising apply
```

[controls.md](controls.md) explains what each group costs you. Apply a group
only after you have read that.

## Automatic boot reapplication

Service masks disappear at every reboot. The startup hook brings them back
without your computer:

```sh
samshush startup audit
samshush startup install
samshush startup run
samshush startup status
```

`install` enrolls only the scopes that already have a completed journal, so
apply and check the controls first. The hook replaces `/opt/etc/parseinfo.sh`,
which the stock `AT-HUB.service` runs at boot. It keeps the original under
`/opt/usr/share/samshush-boot-v1` and runs it first. Then it queues a separate
root job, bounded to 180 seconds, that checks the firmware, the boot service and
its own file hashes before reapplying. It opens no network listener. Results go
to `/run/samshush-boot.result` and `/run/samshush-boot.log`.

After a reboot, check before applying anything from the computer:

```sh
samshush startup status
samshush status
samshush services wifi-presence status   # and each other enrolled group
samshush apps status
```

A passing `startup run` is not a reboot test. Persistence needs a changed boot
ID. `startup status` fails while a job is queued or running.

Run `startup remove` before you restore any control or change the enrolled
groups. It puts the original script back and leaves the current controls in
place. If the hook or its backup has changed, stop and inspect it instead of
overwriting it.

## Recovery

Remove the startup hook first if it is installed, then undo each layer:

```sh
samshush startup remove
samshush restore                              # voice masks
samshush apps restore                         # voice app flags
samshush sound-sensor restore
samshush apps restore --group advertising     # each optional app group
samshush services advertising restore         # each optional service group
```

A runtime restart can fail while the app flags still block the app. Keep the
runtime journal and run `restore` again after `apps restore` succeeds. The same
applies to an optional group: if an app restart fails while its units are still
masked, run its `apps restore --group` again after `services GROUP restore`.
Check both layers and the original processes before calling it recovered.

`apps restore` keeps an audit journal, and a new apply refuses to run over it.
Archive that journal only after the restore is verified and its evidence is saved
locally.

## Rules for retries

- A timeout means the outcome is unknown. Inspect before you retry, and never
  start a second root operation while the first may still be cleaning up.
- The journals are recovery records, not caches. Never delete a journal or a
  stale lock to force an apply.
- On build or preimage drift, or if the service manager looks unhealthy, stop
  changing things and recover first.
- A reboot clears the `/run` masks, but it does not fix a failed persistent
  restore. Check native flags separately.

## State on the TV

| Path | Contents |
| --- | --- |
| `/run/frame-runtime-v1` | Voice mask journal, current boot only |
| `/run/frame-services-GROUP-v1` | Service group journals, current boot only |
| `/opt/usr/home/owner/share/frame-voice-apps-v2` | Voice app flags |
| `/opt/usr/home/owner/share/frame-apps-GROUP-v1` | Optional app group flags |
| `/opt/usr/home/owner/share/frame-sound-sensor-v1` | Ambient-sound flag |
| `/opt/usr/home/owner/share/samshush-native-trial-v1` | Native trial result |
| `/opt/usr/share/samshush-boot-v1` | Startup hook and the original `parseinfo.sh` |
| `/opt/usr/share/samshush-home-v1` | Home button journal |

The `frame-` names come from the original project. The TV already holds journals
under them, so they stay.
