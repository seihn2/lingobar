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
| UI reading and learning | `npm run test:ui` | Linux Chromium, 29 checks at each device scale 1 / 1.5 / 2: partial updates, source alignment, latest translation, history/selection pause, return to live, cross-mode anchor, 1–8 languages, matching ruby above kanji, drag/no-drag regions, opacity persistence and opaque text |
| Production bundles | `npm run build` / `npm run typecheck` | Shared Electron/React/TypeScript builds |
| Windows packaging | `npm run package:win`, `npm run verify:package`, `npm run checksums:win` | Standard Windows CI; x64 NSIS, fixed helper/icon/notice resources, app.asar data exclusions, SHA-256 manifest |
| macOS regression | `npm test`, `npm run package:mac`, native `--self-test`, package inspection | Standard macOS arm64 CI; synthetic-only, no permissions or audio devices |

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
