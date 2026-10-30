# LingoBar — source and third-party notices

LingoBar's project license is [CC BY-NC 4.0](LICENSE). Third-party components
retain their own copyright notices and licenses; the project's noncommercial
terms do not replace those licenses. The license texts in `licenses/` are copied
unchanged from the identified upstream files.

## Penumbra audio components

The following files are adapted or reproduced from
[Penumbra (`seihn2/penumbra`)](https://github.com/seihn2/penumbra), at commit
[`0d5cd439e7eb2b6ae314cf473c287962d42adfdb`](https://github.com/seihn2/penumbra/commit/0d5cd439e7eb2b6ae314cf473c287962d42adfdb).
The upstream project supplies a CC BY-NC 4.0 license notice, preserved in
[licenses/Penumbra-LICENSE.txt](licenses/Penumbra-LICENSE.txt).
The complete license terms are available at
[Creative Commons](https://creativecommons.org/licenses/by-nc/4.0/legalcode.en).

| LingoBar file | Upstream file at that commit | Adaptation |
| --- | --- | --- |
| `resources/native/SystemAudioCapture.swift` | [`resources/native/SystemAudioCapture.swift`](https://github.com/seihn2/penumbra/blob/0d5cd439e7eb2b6ae314cf473c287962d42adfdb/resources/native/SystemAudioCapture.swift) | Changed Penumbra bundle identifiers, dispatch-queue labels, and audio-device display names to LingoBar names. The audio-only process-tap, PCM conversion, framing, lifecycle, and synthetic self-test implementation is retained. |
| `src/main/audio/native-capture.ts` | [`src/main/services/native-system-audio.ts`](https://github.com/seihn2/penumbra/blob/0d5cd439e7eb2b6ae314cf473c287962d42adfdb/src/main/services/native-system-audio.ts) | Relocated the module and changed its shared-protocol import to `./native-protocol`. The helper transport and lifecycle implementation is retained. |
| `src/main/audio/native-protocol.ts` | [`src/shared/native-system-audio.ts`](https://github.com/seihn2/penumbra/blob/0d5cd439e7eb2b6ae314cf473c287962d42adfdb/src/shared/native-system-audio.ts) | Relocated without changing the file contents. |

This attribution identifies the source and modifications; it does not imply
endorsement by the upstream project. LingoBar is built and packaged independently.

### Windows audio port

The Windows audio-only files are adapted from Penumbra commit
[`1b023aad26fc601045fc7948fe16666272d37661`](https://github.com/seihn2/penumbra/commit/1b023aad26fc601045fc7948fe16666272d37661),
under the same CC BY-NC 4.0 notice preserved above:

| LingoBar file | Upstream file | Adaptation |
| --- | --- | --- |
| `resources/native/windows/SystemAudioCapture.cpp` | `resources/native/windows/SystemAudioCapture.cpp` | Renamed namespace to LingoBar; retained audio-only WASAPI, lifetime guard, bounded PCM1 transport and offline fixtures; added explicit backpressure failure and expanded synthetic self-test. |
| `resources/native/windows/AudioFrame.h` | `resources/native/windows/AudioFrame.h` | Renamed namespace; retained bounded little-endian PCM1 framing. |
| `scripts/build-windows-native.cjs` | audio portion of `scripts/build-windows-wheel-monitor.cjs` and `resources/native/windows/CMakeLists.txt` | Builds only LingoBar's x64 audio helper, with static MSVC runtime. No wheel/input helper or unrelated source is included. |
| `scripts/verify-windows-system-audio.cjs` | `scripts/verify-windows-system-audio.cjs` | Restricted to x64; verifies development and packaged binary equality, rejects invalid arguments, and adds restart, broken-pipe and explicit backpressure checks. |

No additional private repository content is included. Windows icon assets are
repackaged from the existing LingoBar artwork in `build/icon.iconset/`.

## JavaScript included in application bundles

The versions below are the installed versions recorded for this release.
React, React DOM, Scheduler, and Lucide are included in the renderer bundle;
`ws` is included in the main-process bundle. Vite contributes its generated
module-preload helper to the renderer. Build and test tools that are not included
in these application bundles are not listed here.

| Component | Version | License notice retained |
| --- | --- | --- |
| React | 19.1.1 | [MIT — react-LICENSE.txt](licenses/react-LICENSE.txt), from `node_modules/react/LICENSE` |
| React DOM | 19.1.1 | [MIT — react-dom-LICENSE.txt](licenses/react-dom-LICENSE.txt), from `node_modules/react-dom/LICENSE` |
| Scheduler | 0.26.0 | [MIT — scheduler-LICENSE.txt](licenses/scheduler-LICENSE.txt), from `node_modules/scheduler/LICENSE` |
| Lucide React | 0.540.0 | [ISC and Feather-derived portions under MIT — lucide-react-LICENSE.txt](licenses/lucide-react-LICENSE.txt), from `node_modules/lucide-react/LICENSE` |
| ws | 8.22.0 | [MIT — ws-LICENSE.txt](licenses/ws-LICENSE.txt), from `node_modules/ws/LICENSE` |
| Vite runtime helper | 7.2.2 | [Vite's supplied license and notices — vite-LICENSE.md](licenses/vite-LICENSE.md), from `node_modules/vite/LICENSE.md` |

The Lucide license file includes both the Lucide and Feather notices exactly as
distributed with version 0.540.0. The optional `ws` native modules `bufferutil`
and `utf-8-validate` are not included in this release.

## Electron runtime

This release uses Electron 43.8.3. Its license is also retained in
[licenses/electron-LICENSE.txt](licenses/electron-LICENSE.txt), copied unchanged
from `node_modules/electron/dist/LICENSE`.

The macOS release package preserves Electron's original runtime license and
third-party notices at:

- `LingoBar.app/Contents/Resources/licenses/electron/LICENSE`
- `LingoBar.app/Contents/Resources/licenses/electron/LICENSES.chromium.html`

These are copied from `node_modules/electron/dist/` during packaging. The full
`LICENSES.chromium.html` is distributed with the application rather than duplicated
in this source repository. It contains the upstream notices for Chromium and the
other components covered by that file. The project's `LICENSE`, this `NOTICE.md`,
and the `licenses/` directory are also included in the application's `app.asar`.

The Windows installer retains the corresponding runtime notices at
`resources/licenses/electron/LICENSE` and
`resources/licenses/electron/LICENSES.chromium.html` beneath its installation
directory. Project notices and component licenses are included in
`resources/app.asar`, as on macOS.

When updating dependencies or producing another platform's package, retain the
notices supplied with the actual runtime and update this inventory and its
packaged paths accordingly.

## Optional offline dictionary data

The independently implemented dictionary engine uses the SQLite runtime already
included with Electron/Node; no new native addon or Yomitan implementation is
copied. Code remains under the project's existing CC BY-NC4.0 license.

The small Kaikki/Wiktextract-derived fixtures and separately built sample packs
are **data under their own license**, not CC BY-NC4.0 application code and not
wiktextract's code license. Their source, transformations, attribution, revision
and CC BY-SA4.0 terms are recorded in
`test/fixtures/offline-dictionaries/` and `docs/offline-dictionaries-data.md`, and
retained in each exported pack/learning snapshot. No full dataset or third-party
audio/image is bundled in the desktop application.
