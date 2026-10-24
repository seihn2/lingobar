# Windows port — validation record

This record separates synthetic automation from Windows hardware acceptance.
No test uses personal audio, real service keys, paid ASR/translation calls, or a
user's computer. The branch is a draft implementation for issue #1; a successful
build does not establish that real capture or translation works on hardware.

## Reproducible test matrix

| Area | Automated check | Environment / limit |
| --- | --- | --- |
| Core state, ASR transport, partial/final translation, selected languages, stale callbacks, queue cancellation, saved captions | `npm test` | Synthetic text/PCM, fake sockets and translators; no provider access |
| Windows native protocol | `npm run test:windows-native` after packaging | Windows CI x64: real EXE, PE architecture, bounded PCM1 silence, ready control message, invalid arguments, EOF, repeated starts, parent death, broken pipe, backpressure, built/packaged byte equality; no audio-device activation |
| Encryption and failure atomicity | Storage unit tests; `node scripts/test-windows-storage.cjs` | Mocked unavailable/encrypt/decrypt failures plus actual Windows CI DPAPI round trip with a synthetic string and fresh temp profile; never plaintext fallback |
| Permissions and IPC | Platform/security tests | Reject other pages, frames, non-audio requests and idle/cancelled runs; Windows cannot invoke macOS key import |
| Microphone and device changes | Mocked microphone tests | Resampling, exact device selection, no device, denied permission, unplug/default change, cancellation/late grant, cleanup; no real microphone |
| Real Electron microphone permission chain | `npm run test:media-permissions` | Electron 43.8.3 / Chromium 150.0.7871.250 with two fake devices, real App/preload/production permission handlers: 25 checks for idle settings selection, exact-device start, pause/reopen/refresh, cancelled late grant, denied request, camera/mixed requests, same-URL subframe, other window and navigated page. No fake UI or real audio device; executed on Linux locally and in all three platform CI jobs |
| UI reading and learning | `npm run test:ui` | Linux Chromium, 29 checks at each device scale 1 / 1.5 / 2: partial updates, source alignment, latest translation, history/selection pause, return to live, cross-mode anchor, 1–8 languages, matching ruby above kanji, drag/no-drag regions, opacity persistence and opaque text |
| Production bundles | `npm run build` / `npm run typecheck` | Shared Electron/React/TypeScript builds |
| Windows packaging | `npm run package:win`, `npm run verify:package`, `npm run checksums:win` | Standard Windows CI; x64 NSIS, fixed helper/icon/notice resources, app.asar data exclusions, SHA-256 manifest |
| macOS regression | `npm test`, `npm run package:mac`, native `--self-test`, package inspection | Standard macOS arm64 CI; synthetic-only, no permissions or audio devices |

Media permission evidence is generated in `artifacts/media-permissions/results.json`.
The Electron fixture uses only `--use-fake-device-for-media-stream`; it explicitly
rejects fake-UI/auto-grant switches so the real permission request gate is tested.
No fixture or test IPC is included in the application archive.

UI evidence is generated in `artifacts/ui-regression/results.json` and
`synthetic-expanded.png` / `synthetic-compact.png`. It uses test-only snapshots, not a service response or a
recording. Native self-test modes never create a COM audio object. Test fixtures
are excluded from the application archive.

## Installation artifact

The workflow `.github/workflows/build.yml` uploads
`LingoBar-windows-x64-<commit>` for 14 days. The archive contains:

- `LingoBar-0.1.5-windows-x64-setup.exe`
- `SHA256SUMS.txt`

Download from the PR's completed workflow run → Artifacts. Compare the installer
using `Get-FileHash .\LingoBar-0.1.5-windows-x64-setup.exe -Algorithm SHA256`.
The installer is unsigned; no production release or auto-update is published.
CI artifacts expire and are not permanent release downloads. Exact run, remote
commit, artifact URL and checksum are reported in the PR and delivery response.

## Still requires a Windows 10/11 x64 machine

- Install/uninstall and first-run behavior under a normal non-admin account;
  SmartScreen, actual DPAPI user profile, login startup, tray and shortcut conflicts.
- WASAPI output on speakers/headphones/Bluetooth/USB, muted/silent playback,
  default-output changes and unplugging; no-device and denied-access behavior.
- Real microphone and dual-source audio, permissions, start/pause/exit/crash,
  repeated starts and switching while starting/listening. Check speaker echo with
  and without headphones. Protected media can be unavailable to loopback.
- Real account end-to-end ASR and translation latency, long-utterance intermediate
  translations and context-sensitive LLM furigana. These paid calls were not made.
- Real Windows 100% / 150% / 200% DPI and mixed-DPI monitors: ruby, sizing,
  selection, scrolling, transparent always-on-top window, native drag hit regions,
  controls and retained history. Chromium scale simulation is not that acceptance.
- macOS actual capture, permissions, keychain prompts and end-to-end services have
  not been rechecked in this Linux container or synthetic CI.

No Windows hardware acceptance has been claimed. Record hardware, OS build,
device/driver and actual observations when filling the remaining matrix.

## Device-selection regression and permission policy

The installer built from `96b0b30` is superseded: its microphone permission check
was gated by the active run, so idle/paused `enumerateDevices()` returned empty
IDs/labels and the settings selector could not list specific microphones. This
was reproduced in actual Electron 43.8.3 / Chromium 150.0.7871.250 using fake
devices, without auto-granting permission UI. Restoring the old check also makes
the new settings regression fail.

The check handler now permits audio permission status queries only for the exact
trusted main-frame document. Chromium uses that status to expose audio input and
output metadata, including while idle. This status can report granted without
authorizing capture: every `getUserMedia` request must still pass the separate
request handler, which requires an explicit current microphone run and
starting/listening state. Camera, mixed media, other contents, subframes and
untrusted URLs remain denied. Actual Electron tests verify both halves; rerun
them when changing Electron versions. OS privacy/device restrictions still need
hardware acceptance and can affect real device names or capture availability.

Upstream source: [Electron's media request entrypoint](https://github.com/electron/electron/blob/v43.8.3/shell/browser/web_contents_permission_helper.cc),
[permission manager](https://github.com/electron/electron/blob/v43.8.3/shell/browser/electron_permission_manager.cc),
[Chromium enumeration permission check](https://github.com/chromium/chromium/blob/150.0.7871.250/content/browser/media/media_devices_permission_checker.cc)
and [device metadata redaction](https://github.com/chromium/chromium/blob/150.0.7871.250/content/browser/media/media_devices_util.cc).
