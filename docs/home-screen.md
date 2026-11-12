# Shortcut Home screen (optional)

`launcher/` is a full-screen web app that can take over the Home button. It is
separate from the privacy controls and the startup hook.

## What it shows

| Part | Contents |
| --- | --- |
| Apps | YouTube (`9Ur5IzDKqV.TizenYouTube`), Stremio (`IkWsFHtOY9.Stremio`), Prime Video (`org.tizen.primevideo`), Samsung TV Plus (`HEPsqFNie0.tvplusstandalone`, a web app hidden from the app list) and Spotify (`rJeHak5zRg.Spotify`). |
| Entradas | Live antenna TV (the source of type `TV`), HDMI 2 and HDMI 1. Settings is a small round button in the bottom right corner. |
| Clock and markets | Date, 24-hour clock, and the dollar, USDT, euro and bitcoin in reais, refreshed every ten minutes while the screen is visible. |
| Sea card | Wave height (two decimals, as Open-Meteo Marine reports it) and period, water temperature and a tide chart for Fortaleza. A wind column shows wind, gusts and the UV peak over the next 18 hours. |
| Forecast panel | Current temperature, feels-like and humidity, plus today's and tomorrow's high, low, sky and rain chance. |
| Moon card | Phase, lit fraction and the date of the next new or full moon. |
| Poço da Draga score | Rates the current tide from 5 (0.6 m or less) to 1 (above 2.1 m), takes a point off when waves reach 1.5 m, and names the next low tide when the score is under 4. |

The dollar, euro and bitcoin come from one AwesomeAPI request. USDT comes from
Binance's public USDT/BRL ticker, because AwesomeAPI has no Tether and its
`USDT-BRL` returns the tourist dollar. Both requests always revalidate, since
AwesomeAPI lets caches serve a quote up to three days old.

The moon is lit on the left while it waxes, as seen south of the equator. The TV
computes the phase from the main terms of Meeus's algorithm, which matched
published phases within two minutes, so the card makes no network request.

The sea and forecast data refresh every 30 minutes while the screen is visible,
and each part hides once its data is six hours old. Text is in Portuguese.

### Tide accuracy

Every Fortaleza beach falls in the same open-sea grid cell, about 15 km offshore.
Against the Porto do Mucuripe table for 28 October to 8 November 2026, the model
tide ran 33 to 85 minutes early. The card shifts it by the 65-minute mean and
rounds the next high and low to 15 minutes, which keeps them within about half an
hour. Heights follow the table, measured from chart datum: across 27 turns that
O POVO published for 3 to 11 November 2026, the table read the model plus 1.35 m,
within 0.17 m.

### Motion

The background is static and the panels have no blur. The focus scale is the only
animation, and reduced motion turns it off. After ten minutes without a key press
the gradient fades to black and the cards stay on a black screen. The key that
brings it back does nothing else, and the countdown stops while an app is in
front. That fade was checked only in the preview.

### Network access

The widget may reach only these origins, one set per module:

| Module | Origins |
| --- | --- |
| `quote.js` | `economia.awesomeapi.com.br`, `api.binance.com` |
| `sea.js` | `marine-api.open-meteo.com` |
| `forecast.js` | `api.open-meteo.com` |
| `moon.js` | none |

The packager rejects any other file or origin.

## Signing

The TV refused a widget signed with the Tizen test distributor (invalid
certificate chain). It installs one signed with a Samsung distributor certificate
issued for its DUID. Create that profile in Tizen Studio's Certificate Manager and
keep certificates under `.local/` or the Tizen data directory, never in Git.

## Build, install and activate

```sh
uv run --project tools tools/launchpad.py --sdk ~/tizen-studio --profile YOUR_PROFILE --output .local/launchpad-build-NEW
samshush launchpad install --widget .local/launchpad-build-NEW/Shortcuts.wgt
samshush launchpad launch
```

Use `--cli /path/to/tizen-wrapper` instead of `--sdk` if needed. The signer uses
the saved profile, so no credentials go on the command line. Build into a fresh
directory every time.

Check every tile, Settings and Back on the TV, then assign the Home button:

```sh
samshush launchpad activate --widget .local/launchpad-build-NEW/Shortcuts.wgt
samshush launchpad status
```

## Update

Keep both signed widgets. `update` checks the installed resources against the
previous widget and requires the Home assignment to be in place:

```sh
samshush launchpad update --widget .local/launchpad-build-NEW/Shortcuts.wgt --previous-widget .local/launchpad-build-OLD/Shortcuts.wgt
```

Widgets built before this fork dropped the Frame launcher still carry its files
(`weather.js`, `water-lilies.jpg`, `time-controls.js` and `weather-config.json`)
and two filesystem privileges. `update` accepts that shape only as the previous
widget. A new build has none of it and is about 87 KB instead of 6.4 MB.

## Restore

```sh
samshush launchpad restore
samshush launchpad archive   # required before activating again
```

`restore` puts the saved Samsung Home assignment back and leaves the app
installed. Remove the app in Samsung's Apps settings if you want it gone.
`archive` renames a restored journal to `samshush-home-v1.archived-UTC` after
checking that its bytes match the saved receipt, and keeps a copy in the local
report. `activate` refuses to run over an existing journal.

## How the Home assignment works

The physical Home button resolves the operation
`http://tizen.org/appcontrol/operation/main` as root. `activate` changes only
that operation and `db/appfw/home_appid`, through the bounded `LaunchpadRouting`
helper in `tools/launchpad_routing.py`. It journals the original values in
`/opt/usr/share/samshush-home-v1`, checks the routing library hashes and the
`tvctx-manager` identity, takes the shared operation lock and rolls back a partial
failure. The overlay, first-screen, startup and backup values and Auto Start are
left alone. Restore refuses unrelated drift and keeps recovery evidence.

On this TV the defaults are `com.samsung.tv.csfs` for Home and the first screen,
`org.tizen.tv-viewer` for startup and backup, and an empty overlay. One
`tvctx-manager` runs as root and the .NET 6.0.9 runtime is present.
`launchpad audit` reads these values and every registered app ID without writing
anything.

The app uses public HDMI source selection and the native TV viewer. Settings
opens `org.tizen.menu` with `Entry=s/setting`, and Back opens
`com.samsung.tv.csfs`. A USB tile that opened Samsung's media browser
(`com.samsung.tv.mycontents`) was dropped: the TV accepted the launch but the
browser stayed in the background.

The installer freezes a verified copy of the widget, checks its upload hash,
installs it through the SDK and then checks the registration and every installed
file under `/opt/usr/apps/PACKAGE/res/wgt`. Host checks cover resources and
digests, not certificate trust; the TV validates the certificate chain.

Never enroll the Home assignment in the startup hook. Reboot and standby
persistence of the assignment are untested.
