# How it works

Samshush runs on your computer and talks to the TV over the local network. The
TV needs no Python; every change is a Bash script that the CLI renders and sends.

1. Samsung's Smart Development Bridge (SDB) listens on TCP port 26101
   once Developer Mode is on. A command-injection flaw in it lets Samshush run
   shell commands. Developer Mode alone gives no root.
2. Flaws in the TV's .NET runtime and Samsung's archive launcher
   give temporary root, using the pinned
   [samsung-tv-root](https://github.com/chris-ritsen/samsung-tv-root) transport.
   No firmware is flashed.
3. Each script first checks the exact build, firmware
   family, architecture and the hashes of every file it will touch. It saves the
   original state in a journal on the TV, makes the change, and reads it back.
4. A helper sends the output back to your computer over an
   authenticated TCP connection to the `--callback-host` address, then exits and
   cleans up. The CLI saves a JSON report under `.local/reports`.

## Native app flags

App flags use the TV's own package manager, as the owner user
(UID 5001), to disable an app. The flag lives in persistent storage and survives
reboots. Checks confirm that the app is gone from the process list and that a
direct launch is refused. Built-in .NET apps run under a shared launcher, so a
process only counts as the app when the exact DLL path is in its arguments.

## Service masks

Service masks are systemd runtime masks in PID 1's mount namespace, applied
together with a stop. They live under `/run` and vanish at the next boot. A group journals
every unit before masking it, masks the batch, reloads systemd once, stops the
units and checks them. A failure part way rolls the whole batch back.

Some apps can come back through an app manager even with their unit stopped, so
the voice controls and the groups that have apps pair app flags with unit masks.

## Boot reapplication

The optional startup hook wraps `/opt/etc/parseinfo.sh`, which Samsung's
`AT-HUB.service` runs early in boot. The wrapper runs the original script, then
queues a separate root job that reapplies every enrolled group from its journal.
Details are in [commands.md](commands.md#automatic-boot-reapplication).

`/opt/etc` is a transmuting SMACK directory, so a file staged below it gains a
`SMACK64TRANSMUTE` label the vendor script never had. Install and removal drop it
before the atomic move, and removal compares labels with the backup.

## What it never does

- Flash or downgrade firmware, or edit firmware images.
- Edit systemd's generated unit cache. A temporary experiment with it in the
  original project stalled PID 1.
- Delete vendor units or edit opaque caches and package databases.
- Record audio or capture network packets.
- Run on a build the profile does not pin.
