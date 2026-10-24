# macOS validation record

This record separates physical Mac observations from synthetic CI and from
Windows acceptance. The authorized local verification reported on 2026-10-24
used the **PR #3 `796a1aaef67b81e7df91e3109859daf73d2c755c` preview** and
120 non-personal synthetic history entries. It did not use real audio, service
keys, personal captions or paid recognition/translation APIs. No private
directories, account identities or local automation transcripts are published.

The app package targets Apple Silicon and macOS 14.2+. The exact machine model
and OS build were not supplied in this handoff; do not infer broader device or
OS coverage. The local environment disconnected again, so this is a completed
subset, not full Mac acceptance. PR #4, real audio, online translation and
Windows 10/11 hardware remain **unverified** by this session.

## Physical Mac: confirmed subset

| Area | Actual observation |
| --- | --- |
| Artifact | Downloaded outer ZIP: 123,500,987 bytes; outer/inner hashes and 606-entry manifest verified; strict signature verification and all 22 helper synthetic self-tests passed |
| Launch and window modes | App launched; expanded and compact subtitle views switched successfully |
| Local search | Cmd+F focused search; original text and pasted Chinese queries matched; zero-match and clearing the query worked |
| Search navigation and focus | Enter/Shift+Enter navigated matches; Esc returned focus; selecting a result located that paragraph |
| Reading | Review and return-to-live worked; compact previous/next navigation worked |
| Opacity | Background opacity changed to 45%, then 100%, then restored to 94% |

Chinese **paste** passing does not establish native IME composition. The tested
Esc return is one focus transition, not a complete keyboard focus-loop audit.
The helper self-test explicitly reports `captureStarted:false`; it is not an
audio-device capture test. UI results above belong to the exact preview head,
not to later rebuilds or to a combination of PR #3 and PR #4.

Artifact provenance: [CI 40109468812](https://github.com/seihn2/lingobar/actions/runs/40109468812),
[Mac preview artifact](https://github.com/seihn2/lingobar/actions/runs/40109468812/artifacts/12565468417).
CI built test-merge checkout `819cc420246881aeded55bb5af8a63ef722141d3`, with
source head above and base `857ec2c632b38b4ad50276be48524b2f8dc2571b`.
Its production `src` tree is `a165814f24db3d3589b12b31c6798b0f77a855f8`.
Artifact download needs GitHub sign-in and expires 2026-11-07.

```text
Inner app ZIP  9d30664253b4362bcfbe56d2e87c88251e79c88999d8135524d65cd394c49ad0
Outer ZIP      7a6aa705dffc76e989d12a883e70efdcf1146914d69c3f03b5c5f205a83435f8
Manifest       becb4832db245a3cfe7f1cdd6b9f1a27c274dc55119ab07017efd3a98ea61167
```

## Pending and uncertain

- Native dragging/resizing, font size, tray/menu-bar interaction, native IME,
  the complete focus loop and application quit were not validated.
- Hide controls and the show/hide shortcut were attempted, then a window was
  still observed. The evidence does not establish which input, IPC, native
  visibility or activation events occurred. Keep this **unconfirmed**, not a
  reproduced defect or a passing hide/show test.
- The environment disconnected; the final settings click has an unknown
  outcome. No later setting state, cleanup or successful quit is claimed.
- PR #4 pause/final draining, real microphone/system/both-source capture,
  native OS permission flows, Keychain prompts and real provider behavior were
  not tested. Windows remains a separate hardware acceptance task.

## Cloud check of visibility routing

The checked PR3 source has these explicit paths:

- Renderer hide button → production preload → trusted `lingo:hide` →
  `BrowserWindow.hide()`. Native close also prevents closing and hides.
- The registered `CommandOrControl+Alt+L` callback toggles `isVisible()` between
  hide and show/focus. A registration conflict produces a visible message.
- Startup `ready-to-show`, tray/menu show actions, a second instance and Mac
  `activate` explicitly show the window. Ordinary partial/snapshot/settings
  publishing does not call show.

Electron documents that Mac `activate` can follow Dock activation or relaunch;
an explicit activation is therefore a possible redisplay path, **not an
established explanation of the local observation**. Source review and synthetic
tests do not reproduce native Mac visibility behavior.
[Electron 43.8.3 activate contract](https://github.com/electron/electron/blob/v43.8.3/docs/api/app.md#event-activate-macos).

The cloud follow-up adds five installed-main-handler regression tests for
trusted/foreign hide, capture continuity, repeated shortcut toggles, hidden
partial/settings/stop updates and explicit activation/tray/second-instance
recovery. Chromium UI tests use actual DevTools mouse move/press/release input
to hit expanded and compact hide controls, checking their no-drag hit targets
and one API call. These are synthetic routing tests, not global-key/native
window tests. No application code is changed on this evidence.

For a later authorized physical retest, record the input and window identifier,
visibility immediately after the action, and whether an activation or second
instance occurs before the next observation. Do not automatically reactivate
the app while trying to determine whether it stayed hidden. Keep the current
uncertain result until that trace exists. Use the
[offline checklist](macos-offline-validation.md), preserving OS protections,
fresh test data and the no-real-audio/no-service boundary.
