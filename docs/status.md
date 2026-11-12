# Status of the supported TV

Supported TV: Samsung QN55Q65DAGXZD, Tizen 9, ARMv7, build
`T-NKLDUABC-0090-REL-202603190159` (menu firmware 2123.9). The detailed,
timestamped record lives in the ignored `.local/reports/current-state.json`.
Update it after live work.

## Verified

| Control | Evidence |
| --- | --- |
| Native trial | Disable, launch denial and restore of `org.tizen.voice-onboarding` passed before the batch. |
| Voice apps | 23 apps denied direct launches on 2026-10-29. Flags survived the 2026-10-30 reboot. |
| Ambient sound | Launch denied on 2026-10-29. The flag survived the reboot. |
| Voice units | 19 units masked. After the reboot they were reapplied and `status` passed. |
| Wi-Fi presence | Masked, reapplied after the reboot. |
| Advertising | Two app flags persisted. The first status after the reboot failed because `adagent-service` was running again; it passed after reapplying the unit mask. |
| Reporting, presence sensing, remote support | Live apply and mask readback passed on 2026-10-30. |
| Remote PC, Gaming Hub backend | Apps denied launches and units masked on 2026-10-30. `gamepad-service` stopped during the Gaming Hub app apply; its bus name kept listening. |
| Context data | `data-service` and both logger bus names masked on 2026-11-01. Logger calls then fail in about 30 ms instead of blocking, and the owner reported fast soundbar volume. |
| Startup hook | Installed with nine scopes. `startup probe`, `run` and `status` passed. |
| Shortcut Home | Installed, launched, assigned, restored, archived and assigned again on 2026-11-11. The owner confirmed every app tile, both HDMI inputs, live antenna TV, Settings, Back and the physical Home button. |

## Gaps

- A fresh reboot with the startup hook installed has not been verified.
- After the optional groups, HDMI, Netflix, the browser, subtitles and the remote
  have not been retested.
- Controller use is untested since `gamepad-service` stopped.
- Samsung Analytics and the context-aware agent still run; no group covers them.
- The physical microphone switch is not confirmed.
- Complete microphone capture denial is not established.
- Auto Update read On at the last check. Turn it off in the TV menu.
- `net.auad` and `org.tizen.remotepc` still block their D-Bus callers until a
  timeout. Four other names did the same on 2026-10-31 and failed immediately on
  2026-11-01, for an unknown reason. A 102-second trace around a volume burst
  showed no calls to any of them.
- "Start with Smart Hub Home" reads Off (`db/menu/smart_hub/ontvsetting/auto_start`
  is 0). Nobody has watched what the TV opens at power-on.
- Reboot and standby persistence of the Home assignment are untested.
- The tide correction is a fixed mean. Check it against the Mucuripe table during
  neap and spring tides.

## Network

On 2026-11-11 `network-audit` read the Ethernet link at 100 Mbps full duplex,
with Wi-Fi off. That link can limit 4K streaming.
