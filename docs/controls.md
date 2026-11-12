# Controls on the Q65D

These recommendations assume you use HDMI devices and streaming apps and don't
need voice assistants or sound sensing. "Applied" means the control passed live
apply and readback on the supported TV. It does not mean every retained feature
was tested afterwards; see [status.md](status.md) for that.

| Service or feature | Control | What it does and what you lose |
| --- | --- | --- |
| Bixby, Alexa and voice recognition | `apps apply` (23 apps), applied | Native app flags stop the assistants, speech recognition and wake-word apps from launching. Verification also looks for built-in .NET apps that survive under a shared launcher. |
| Always-on voice, virtual mic, Bluetooth HFP and soundbar voice passthrough | `apply --scope voice` (19 units), applied | Masks the services behind voice activation, the virtual microphone, hands-free Bluetooth and voice passthrough. This build has no `wakeupless` or `farfieldvoice` units. Normal Bluetooth and audio output are not targeted. |
| Ambient sound | `sound-sensor apply`, applied | Blocks `ambient-sound`, which uses the microphone for sound detection. The shared sensor service is not targeted. |
| LAN presence | `services wifi-presence apply`, applied | Stops the LAN presence service, which runs even on Ethernet. Turning off the Wi-Fi radio does not stop it. |
| Advertising | `apps apply --group advertising` and `services advertising apply`, applied | Blocks `adagent-service` and `targeted-ad-service`. PISA stays enabled because it also handles account consent. The CoBA ad agent is registered but its executable is missing on this build, so it is left alone. In-app ads in YouTube or Netflix are not affected. |
| Diagnostics and reporting | `services reporting apply`, applied | Masks media analytics, the device tracker, abnormal-behavior and issue reporting, and the emergency log transmitter. |
| Wi-Fi motion and user presence | `services presence-sensing apply`, applied | Masks Wi-Fi motion, user presence and the awareness agents. Presence-based automatic dimming and power saving can stop working. |
| Context data collection | `services analytics-context apply`, applied | Masks the context-aware collector, `data-service` and the logger's two D-Bus names. The bus names have to go with the service: `hdmicec-service` logs every CEC volume step, and with only `data-service` masked the soundbar volume took about 3 seconds per step. |
| Remote support and shop management | `services remote-support apply`, applied | Stops Remote Management, Easy Support and Shop Care. Owner SDB and normal remote navigation are not targeted. |
| Remote PC | `apps apply --group remote-pc` and `services remote-pc apply`, applied | Blocks the Remote PC launcher and its service. This is not a vulnerability finding. |
| Gaming Hub backend | `apps apply --group gaming-backend` and `services gaming-backend apply`, applied | Blocks the two backend apps and the daemon. Applying the apps also stopped `gamepad-service`, which stays D-Bus activated. Controller use is untested. |
| App sync and background updates | `optional-delivery`, pinned, not applied | Would stop automatic app updates and app synchronization. Manual firmware updates and shared package tools would keep working. Apply it only if you accept losing automatic app updates. |
| Automatic firmware updates | Manual: turn Auto Update off | A firmware update replaces the pinned build. Every command then refuses to run, and the root exploit may be patched. Update manually only after checking compatibility. |
| Viewing Information Services | Manual opt-out | Viewing-data consent is separate from voice settings. Turn it off in the TV's privacy settings. |
| Built-in microphone | Manual check | Look for a physical microphone switch on this TV and set it to Off. The remote has its own microphone. Neither has been confirmed on this TV. |
| HDMI-CEC, ARC/eARC, playback, networking, DRM, Settings and the browser | Not changed | Samshush leaves the TV's core functions alone. The soundbar on HDMI 2 is the only CEC device. |
| Home screen | Optional [shortcut Home](home-screen.md) | Replaces Samsung Home on the Home button with a full-screen shortcut app. Back returns to Samsung Home. |

## Limits

This does not cover every microphone path or telemetry source. The voice
controls block the known apps and services; they do not prove that no process can
capture audio. Samsung Analytics and the context-aware agent still run because no
group covers them yet. `net.auad` and `org.tizen.remotepc` still make their D-Bus
callers wait for a timeout.

Several groups from the original project do not apply to this build.
`visual-analysis` and `screen-recognition` would need a reduced definition,
`ai-models` and `voice-launchers` target apps that are absent, and the build has
no vendor startup guards. Certificate overlays, the Auto Update control and the
blanket service scopes are not part of this fork.

## Persistence

Native app flags live in persistent storage and survived the 2026-10-30 reboot.
Service masks live under `/run` and last one boot. The optional
[startup hook](commands.md#automatic-boot-reapplication) reapplies them in the
background after each boot. A firmware update can undo any of this.
