<div align="center">
  <img src="build/icon.png" width="96" alt="LingoBar icon">
  <h1>LingoBar · 语伴</h1>
  <p><strong>Hear a sentence. Understand it in several languages.</strong><br>A lightweight multilingual caption bar that stays on your desktop.</p>
  <p><a href="README.md">简体中文</a> · <strong>English</strong> · <a href="README.ja.md">日本語</a></p>
  <p>macOS 14.2+ · Windows 10/11 x64 · 0.1.5 · CC BY-NC 4.0</p>
</div>

[User guide](docs/usage.en.md) · [Install and download](#install) · [Development and builds](#development) · [Validation status](#validation)

LingoBar translates computer audio, microphone input, or text you type into the languages you choose, so you can study sentences side by side. Translation starts as soon as a partial transcript is available; Japanese furigana follows above the corresponding kanji. The view follows the latest available translation by default, and you can pause following whenever you want to look back.

LingoBar is an independent application with its own settings, saved captions, and installation packages. The interface is currently mainly in Simplified Chinese. Documentation is available in Chinese, English, and Japanese; caption languages are selected separately.

![Synthetic captions in the current LingoBar expanded view](docs/images/expanded.png)

*An actual capture of the current interface in Linux Chromium, using synthetic captions with French and Japanese selected. This is not a screenshot of audio capture on a physical Windows machine. No speech recognition or translation service was called.*

## What you can do

- Select and order 1–8 of the 20 available languages. Chinese, English, and Japanese are selected by default; only checked languages are translated.
- Use computer audio, the microphone, or both. During a long sentence, the transcript and translations continue to fill in within the same segment.
- Japanese translations appear before their furigana, which comes from the same translation model. A reading failure does not remove the translation.
- Read in the expanded view or collapse to a compact window, keeping the original, all selected languages, text selection, and access to earlier segments.
- Keep the window on top, adjust background opacity and font size, use wide drag areas and the system tray, and optionally launch at login. Export saved captions as Markdown.

<a id="install"></a>
## Install and download

| Platform | How to get it and requirements |
| --- | --- |
| Windows | Windows 10/11 **x64**. Download the test artifact from the latest successful CI run linked in [Draft PR #2](https://github.com/seihn2/lingobar/pull/2), extract it, and run `LingoBar-0.1.5-windows-x64-setup.exe`. The package includes `SHA256SUMS.txt`. |
| macOS | Apple Silicon and macOS 14.2+. Build `LingoBar.app` from source using the commands below; the repository does not have a formal release download. |

The Windows test installer is **unsigned**; Windows ARM64 is not currently supported. Local Mac builds use an ad-hoc signature and are not notarized by Apple. Verify the source and checksums before installing. [CI build records](https://github.com/seihn2/lingobar/actions/workflows/build.yml?query=branch%3Acodex%2Fwindows) do not establish validation on physical hardware.

Downloading artifacts requires signing in to GitHub. Artifacts are retained for 14 days; after expiry, obtain a newer successful build or build from source. **The installer from the old commit `96b0b30` has a bug that prevents selecting a specific microphone while idle. Replace it with a package built from the fix baseline `f7a64b8` or a later commit.** Before upgrading, choose **退出 LingoBar** (Quit LingoBar) from the tray or menu bar to exit the old app, then install or replace it with the new version. This branch remains in a draft PR. It has not been merged, deployed, or published as a formal release.

## Get started in five steps

1. Open the app and click **看看示例** (View example) to explore the layout. The example does not record audio or call services.
2. Open **设置 → 服务连接** (Settings → Service connections). Enter the endpoint, model, and separate API key for speech recognition and translation, then click **保存设置** (Save settings).
3. Choose computer audio, the microphone, or both. You can select a specific microphone before starting; listing or refreshing devices does not start recording.
4. Open **设置 → 字幕语言** (Settings → Caption languages) to select and order languages. Enable **日语汉字注音** (Japanese kanji readings) if needed.
5. Click **开始聆听** (Start listening). Scroll or select text to look back, and click **回到实时** (Back to live) to resume following. Click **暂停** (Pause) to stop audio capture; hiding the window does not pause it.

Speech recognition defaults to DashScope's Beijing-region `qwen-audio-3.1-asr-flash-streaming`. Translation defaults to DeepSeek `deepseek-flash`; the client disables thinking mode to reduce waiting. Configure a key for each service, and ensure each account has access to the selected model. **Online recognition, translation, and furigana may incur API charges.** Latency and supported recognition languages depend on the network, devices, and models you choose.

See the [full user guide](docs/usage.en.md) for service fields, system permissions, window controls, and troubleshooting.

## Compact window and shortcuts

![Synthetic captions in the current LingoBar compact window](docs/images/compact.png)

*A compact view of synthetic captions in the same current interface. Native window dragging, different DPI settings, and hardware audio still require testing on physical machines.*

Drag the compact window using its 20px top strip or the 8px blank areas along the sides and bottom. Caption text remains selectable and scrollable. Controls appear on hover or keyboard focus. Background opacity ranges from 45–100%, while text stays clear.

| Action | Windows | macOS |
| --- | --- | --- |
| Show/hide the caption bar globally | `Ctrl+Alt+L` | `⌘⌥L` |
| Submit typed text in the input panel | `Ctrl+Enter` | `⌘ Enter` |
| Start/pause listening | Interface or tray menu | Interface or menu bar menu |

If another application uses the shortcut, reopen LingoBar from the tray or menu bar. The close button hides the app; choose **退出 LingoBar** (Quit LingoBar) from the menu to exit.

## Data and privacy

- The first launch does not start audio capture. Launching at login does not automatically resume listening either. Computer audio capture records audio only, with no screen capture: Windows uses WASAPI loopback, and Mac uses Core Audio.
- After you start listening, audio is sent over an encrypted connection to the configured recognition service. Transcripts or typed text are sent to the translation service. The providers' data handling terms apply separately.
- The main process encrypts keys using Electron `safeStorage` (Mac Keychain / Windows DPAPI) and does not send decrypted keys back to the interface. Saving is refused if encryption is unavailable or fails; there is no plaintext fallback.
- Audio recordings are not saved. Regular sessions keep approximately the latest 150 sentences in memory. Captions you explicitly save are stored locally, up to 1,000 sentences, and can be exported as Markdown.
- Data directories: Mac `~/Library/Application Support/LingoBar`; Windows `%APPDATA%\LingoBar`. The application ID is `com.lingobar.app`.
- On Mac, **导入语音识别密钥** (Import speech recognition key) reads one fixed local Keychain entry only when you click it. Windows hides and rejects this feature.

<a id="development"></a>
## Development and builds

The shared project uses Node.js **22.18+** (22 LTS recommended) and npm. Read the scripts before running them, and use `npm ci` to keep dependencies locked.

```sh
git clone https://github.com/seihn2/lingobar.git
cd lingobar
git switch codex/windows
npm ci
npm test
npm run typecheck
```

| Platform | Build requirements | Packaging command | Output |
| --- | --- | --- | --- |
| macOS | Apple Silicon, macOS 14.2+, Xcode Command Line Tools | `npm run package:mac` | `dist/mac-arm64/LingoBar.app` |
| Windows x64 | Windows, CMake 3.24+, Visual Studio 2022 Desktop development with C++ tools, Windows SDK | `npm run package:win` | `dist/LingoBar-0.1.5-windows-x64-setup.exe` |

Before starting development, run `npm run build:native`. On Windows, also run `npm run build:icons`. Then run `npm run dev`. Native components must be built on the target platform.

| Check | Command |
| --- | --- |
| Production build and type checking | `npm run build` |
| Synthetic-device permission flow in real Electron | `npm run test:media-permissions` |
| Synthetic caption UI in Chromium (requires an installed browser) | `npm run test:ui` |
| Synthetic tests of the packaged Windows helper | `npm run test:windows-native` |
| Package contents, resources, and third-party notices | `npm run verify:package` |
| Windows installer SHA-256 checksums | `npm run checksums:win` |

<a id="validation"></a>
## Version and validation status

The current code version is **0.1.5**; use the commit ID to identify the included features and fixes. Windows, macOS, and Ubuntu CI run synthetic-device permission tests in real Electron. These tests do not use fake UI auto-authorization, access real microphones or personal audio, or call paid APIs.

**Validation on physical Windows 10/11 machines remains outstanding** for audio capture, devices and system permissions, the tray and shortcuts, launch at login, installation/uninstallation with a standard account, native dragging, and real 100% / 150% / 200% DPI settings. Browser zoom simulations and successful CI builds cannot replace these checks. This round of Mac CI also did not revalidate real audio capture, Keychain prompts, or end-to-end operation with real services.

See the [test matrix](docs/windows-validation.md) and [Windows port notes](docs/windows-port.md). When reporting a problem, include the commit ID, operating system, devices, display scaling, and reproduction steps. Remove keys, personal captions, and recordings first: [Issues](https://github.com/seihn2/lingobar/issues).

## Sources and license

Audio components, the frame protocol, and parts of lifecycle handling are adapted from [Penumbra](https://github.com/seihn2/penumbra). LingoBar's multilingual learning interface and saved-caption features were implemented independently. See [NOTICE.md](NOTICE.md) for specific source commits and modifications. Screenshots come from this project's synthetic interface tests.

The project uses [CC BY-NC 4.0](LICENSE), which permits noncommercial use, modification, and sharing with attribution, preservation of the license, and an indication of changes. Commercial use requires separate permission. Third-party dependencies retain their own licenses. This is a source-available project under a noncommercial license and does not qualify as open source under the OSI definition.
