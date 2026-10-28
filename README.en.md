<div align="center">
  <img src="build/icon.png" width="104" alt="LingoBar icon">
  <h1>LingoBar · 语伴</h1>
  <p><strong>Turn what you hear into multilingual captions you can compare and revisit.</strong></p>
  <p>
    <a href="https://github.com/seihn2/lingobar/actions/workflows/build.yml?query=branch%3Amain"><img src="https://github.com/seihn2/lingobar/actions/workflows/build.yml/badge.svg?branch=main&amp;event=push" alt="Build and synthetic tests"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-CC%20BY--NC%204.0-blue.svg" alt="CC BY-NC 4.0"></a>
    <a href="package.json"><img src="https://img.shields.io/badge/version-0.1.5-6f42c1.svg" alt="Version 0.1.5"></a>
    <a href="package-lock.json"><img src="https://img.shields.io/badge/Electron-43.8.3-47848F.svg?logo=electron" alt="Electron 43.8.3"></a>
    <a href="package-lock.json"><img src="https://img.shields.io/badge/React-19.1.1-61DAFB.svg?logo=react&amp;logoColor=111" alt="React 19.1.1"></a>
  </p>
  <p><a href="README.md">简体中文</a> · <strong>English</strong> · <a href="README.ja.md">日本語</a></p>
</div>

[User guide](docs/usage.en.md) · [Install](#install) · [Quick start](#quick-start) · [Contributing](#contributing)

LingoBar is a desktop caption tool for language learning. It translates computer audio, microphone input, or text you type into your chosen languages, presenting the original, translations, and Japanese readings together in a lightweight floating window. Read as you listen and return to individual sentences for review.

Built with Electron, React, and TypeScript, the project is **source-available under the noncommercial CC BY-NC 4.0 license**. The app interface is currently mainly in Simplified Chinese. Chinese, English, and Japanese documentation and the selectable caption output languages are separate from the interface language.

<a id="validation"></a>
> [!IMPORTANT]
> **This is a development preview distributed through source code and CI test packages, with no formal release yet.** Windows packages are unsigned. Real audio capture, devices, and DPI behavior on Windows 10/11 still require testing on physical machines. A successful build does not establish hardware validation; see the [validation status](docs/windows-validation.md).

![LingoBar multilingual caption interface](docs/images/expanded.png)

*A synthetic caption example in the current interface, actually captured in Linux Chromium. This is not a screenshot of audio capture on a physical Windows machine. [Screenshot provenance](docs/images/README.md)*

<a id="overview"></a>
## Features

- **Listen and compare as you go.** Use computer audio, the microphone, or both. Translation starts from partial transcripts during long sentences and continues updating the same segment, making it useful for lessons, videos, and speaking practice.
- **Choose languages for your learning goals.** Select and order 1–8 of the 20 available languages. Chinese, English, and Japanese are the defaults; only selected languages are translated.
- **Read Japanese pronunciation in context.** Translations appear first, followed by context-aware furigana from the translation model above the corresponding kanji. Readings never block the translation.
- **Follow live captions or stop to read.** The view follows the latest available translation by default. Scroll or select text to look back, then click **回到实时** (Back to live) to resume following.
- **Keep sentences worth revisiting.** Collapse to a compact window, keep it on top, and adjust background opacity and font size. Save completed segments and export them as Markdown study notes.
- **Find history locally.** Current source supports lookup across retained originals and existing translations, opened with `Ctrl+F` / `⌘F`. See the [guide](docs/usage.en.md#history) for scope and controls. Earlier `main` preview packages lack this feature; use a successful build from the optimization PR or build a commit containing the change.

<a id="install"></a>
## Install

| Platform | System requirements | How to get it |
| --- | --- | --- |
| Windows | Windows 10/11, **x64** | [CI test packages](https://github.com/seihn2/lingobar/actions/workflows/build.yml?query=branch%3Amain): download the ZIP from the corresponding successful build's Artifacts, extract it, and run the installer. |
| macOS | macOS 14.2+, Apple Silicon | [PR #3 offline preview](docs/usage.en.md#install), or [build from source](#development). The preview is ad-hoc signed and not Apple-notarized; PR #4 changes are separate. |

Windows x64 support is merged into `main`; see [PR #2](https://github.com/seihn2/lingobar/pull/2) for earlier verified test packages and checksum records. Windows ARM64 packages are not currently available. Downloading CI artifacts requires signing in to GitHub. Artifacts are retained for 14 days; after expiry, obtain a newer successful build or build from source. Check the included `SHA256SUMS.txt` before installing. See the [user guide](docs/usage.en.md#install) for installation, upgrades, and system permissions.

<a id="quick-start"></a>
## Quick start

1. Open LingoBar and click **看看示例** (View example) to explore the reading experience. The example does not capture audio or call services.
2. Open **设置 → 服务连接** (Settings → Service connections), configure speech recognition and translation separately, then click **保存设置** (Save settings).
3. Choose computer audio, the microphone, or both. Select a specific microphone in settings beforehand if needed, then save the change.
4. Open **设置 → 字幕语言** (Settings → Caption languages) to select and order languages. You can enable **日语汉字注音** (Japanese kanji readings), then save settings.
5. Click **开始聆听** (Start listening). After looking back, use **回到实时** (Back to live) to resume following. Click **暂停** (Pause) to stop audio capture; hiding the window does not pause it.

Global shortcuts: **`Ctrl+Alt+L`** on Windows and **`⌘⌥L`** on Mac show or hide the caption bar. See the [full guide](docs/usage.en.md) for window drag areas, opacity, typed-text translation, and saved captions.

<a id="configuration"></a>
## Service configuration

| Purpose | Default service and model |
| --- | --- |
| Real-time speech recognition | DashScope Beijing region, `qwen-audio-3.1-asr-flash-streaming` |
| Caption translation and optional Japanese furigana | DeepSeek, `deepseek-flash` |

Enter an API key for each service, and ensure each account has access to its selected model. **Online recognition, translation, and furigana may incur API charges.** Selecting caption languages does not mean the ASR model recognizes all those languages. Latency and recognition coverage depend on the network, devices, and models.

See the [service configuration guide](docs/usage.en.md#services) for all fields, supported protocols, and permissions. For device changes or connection failures, start with the [troubleshooting table](docs/usage.en.md#troubleshooting).

<a id="documentation"></a>
## Documentation

Desktop learning: [explicit AI context explanations, independent history and active review](docs/dictionary-learning.md) (current draft; generated content may be inaccurate; no offline dictionary import).

| Language | User guide |
| --- | --- |
| 简体中文 | [安装、配置与日常使用](docs/usage.zh-CN.md) |
| English | [Installation, configuration and everyday use](docs/usage.en.md) |
| 日本語 | [インストール・設定・使い方](docs/usage.ja.md) |

Developer and platform references: [Windows port notes](docs/windows-port.md) · [Test matrix, known limitations, and build records](docs/windows-validation.md) · [Mac physical UI subset and pending checks](docs/macos-validation.md) · [Third-party sources](NOTICE.md).

<a id="development"></a>
## Development and builds

Node.js **22.18+** and npm are required. Build native components on the target platform:

| Platform | Additional tools |
| --- | --- |
| macOS | Apple Silicon, macOS 14.2+, Xcode Command Line Tools |
| Windows x64 | CMake 3.24+, Visual Studio 2022 Desktop development with C++ tools, Windows SDK |

`main` includes Windows x64 support. Use the locked dependencies to start the local project:

```sh
git clone https://github.com/seihn2/lingobar.git
cd lingobar
git switch main
npm ci
npm run build:icons
npm run build:native
npm run dev
```

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | TypeScript type checking |
| `npm test` | Core logic and state regression tests |
| `npm run build` | Type checking and production build |
| `npm run test:media-permissions` | Synthetic-device permission checks in real Electron |
| `npm run test:ui` | Synthetic caption interaction checks in an installed Chromium browser |
| `npm run test:dictionary-ui` | Synthetic dictionary/history/review DOM and accessibility-tree checks |
| `npm run package:mac` | Build the Mac application directory |
| `npm run package:win` | Build the Windows x64 NSIS installer |

Build output is in `dist/`. Commands for checking the native helper, package contents, and checksums are in [build and validation notes](docs/windows-validation.md).

<a id="contributing"></a>
## Contributing

Contributions are welcome: focused fixes, device compatibility reports, accessibility improvements, tests, and documentation translations. When reporting a problem, include the commit ID, operating system version, audio source or device, display scaling, reproduction steps, and expected and actual behavior: [GitHub Issues](https://github.com/seihn2/lingobar/issues).

Before submitting a PR, run `npm run typecheck`, `npm test`, and `npm run build`. Add meaningful tests for behavior changes and state which platforms you actually validated. Report real-device results separately from synthetic tests. Keep keys, recordings, and personal captions out of screenshots, logs, and test fixtures.

<a id="privacy-license"></a>
## Privacy and license

LingoBar does not register or restore launch at login; legacy enabled preferences are treated as off. Startup and ordinary settings saves do not modify OS login items. Removing a previous entry requires an explicit action, and actual system state still needs verification.

The app does not start audio capture on first launch or save recordings. After you start listening, audio is sent over an encrypted connection to the configured recognition service, and transcripts or typed text are sent to the translation service. The main process encrypts keys using Electron `safeStorage`. If encryption is unavailable or fails, saving is refused with no plaintext fallback. See the [privacy guide](docs/usage.en.md#privacy) for data retention, system permissions, and provider responsibilities.

The project uses [CC BY-NC 4.0](LICENSE), which permits noncommercial use, modification, and sharing with attribution, preservation of the license, and an indication of changes. Commercial use requires separate permission. This is a source-available project and does not qualify as open source under the OSI definition. Third-party dependencies retain their own licenses.

Audio components, the frame protocol, and parts of lifecycle handling are adapted from [Penumbra](https://github.com/seihn2/penumbra). LingoBar's multilingual learning interface and saved-caption features were implemented independently. See [NOTICE.md](NOTICE.md) for source commits and modifications.
