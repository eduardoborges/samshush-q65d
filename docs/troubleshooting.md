# Troubleshooting

## `sdb connect` fails while port 26101 is open

Developer Mode accepts only the computer address you entered on the TV. A Mac on
Wi-Fi and Ethernet at the same time can reach the TV through the other interface.
Route the TV through the registered interface, or enter the other address on the
TV and reboot it.

## `sdb devices` lists the TV but every command says `error: target not found`

Restart the local SDB server. This fixed it once without any change on the TV:

```sh
sdb kill-server
sdb connect "$TV"
```

The same restart helped when the local server could not reconnect after a power
cycle even though the TV ports were open.

## A command timed out

The outcome is unknown. Read the report in `.local/reports`, run the matching
`status` command, and only then decide whether to retry. Don't start a second
root operation while the first may still be cleaning up.

## Putting the TV in standby without the remote

The CLI has no power command. Send `KEY_POWER` through the TV's remote-control
WebSocket, `wss://TV:8002/api/v2/channels/samsung.remote.control`. The TV may ask
you to allow a new client name the first time. `GET http://TV:8001/api/v2/`
reports `PowerState`. On 2026-11-11 it read `standby` right after the key, while
SDB and the remote-control ports stayed open.

## The soundbar volume is slow from the TV remote

`hdmicec-service` logs every CEC volume step to `org.tizen.tv.logger`. If
`data-service` is masked but the logger bus names are not, each step waits for a
D-Bus timeout, about 3 seconds. The `analytics-context` group masks both bus names
for this reason. Check it with `samshush services analytics-context status`.

## Commands refuse to run after a firmware update

Every TV command checks the exact build. After an update the profile no longer
matches, and nothing should run until a new profile exists. See
[development.md](development.md#a-new-firmware-build). Don't edit the build string
to get past the check.
