# LingoBar · 语伴 User Guide

[简体中文](usage.zh-CN.md) · **English** · [日本語](usage.ja.md) · [Back to README](../README.en.md)

Keep the original and translations close at hand, and study each sentence at your own pace. This guide follows **the current source revision of version 0.1.5**; check a test package’s build commit to confirm its features. The interface is currently mainly in Simplified Chinese, so this guide preserves the actual Chinese button names and explains their meaning in English.

[Install](#install) · [Service configuration](#services) · [Audio and permissions](#audio) · [Live translation](#live) · [Languages and furigana](#languages) · [History and saved captions](#history) · [Window and shortcuts](#window) · [Privacy](#privacy) · [Troubleshooting](#troubleshooting) · [Validation status](#validation)

<a id="install"></a>
## 1. Install and open for the first time

| Platform | Steps |
| --- | --- |
| Windows 10/11 x64 | Open [CI for the main branch](https://github.com/seihn2/lingobar/actions/workflows/build.yml?query=branch%3Amain) and download the Windows test package from **Artifacts** in a successful build. Sign in to GitHub to download the ZIP, extract it, check `SHA256SUMS.txt`, and run `LingoBar-0.1.5-windows-x64-setup.exe`. Then open LingoBar from the Start menu. |
| macOS 14.2+ / Apple Silicon | Download **LingoBar-macos-arm64-preview-…** from a successful [PR #3](https://github.com/seihn2/lingobar/pull/3) CI run. Extract the outer artifact ZIP, verify the inner app ZIP and `BUILD-MANIFEST.json` against `SHA256SUMS.txt`, then extract the app ZIP with Finder or `ditto -x -k app.zip output`. No Node/Xcode installation is required to run this preview. [Source builds](../README.en.md#development) remain available. |

The Windows installer is unsigned, so Windows may show a warning about its source. Verify the source and SHA-256 before deciding whether to run it; you do not need to disable system protections. Mac previews and local builds use an ad-hoc signature and are not notarized by Apple. Keep system protections enabled; do not remove quarantine or re-sign the download. Rebuilding may require granting permissions again. The PR #3 preview does not include PR #4's pause changes. The manifest distinguishes the PR head from the actual CI test-merge build; CI is not hardware acceptance. Offline preview via **看看示例** makes no service calls. [Technical verification checklist](macos-offline-validation.md).

Artifacts are retained for **14 days** and are not permanent release downloads. After expiry, use a newer successful build or build from source. Windows ARM64 is not currently supported. The old package from commit **`96b0b30`** has a bug that prevents selecting a specific microphone while idle; replace it with a package built from the fix baseline **`f7a64b8`** or a later commit. Before upgrading, choose **退出 LingoBar** (Quit LingoBar) from the tray or menu bar to exit the old app, then install or replace it with the new version. The Windows implementation has been merged into `main` through [PR #2](https://github.com/seihn2/lingobar/pull/2). It is still distributed as a development preview, with no formal release yet.

The app does not start audio capture on first launch. Click **看看示例** (View example) to explore synthetic captions without calling services. To check your translation configuration, open **输入文字翻译** (Translate typed text), type or paste a sentence, then click **翻译这句** (Translate this sentence) or use `Ctrl+Enter` on Windows / `⌘ Enter` on Mac, as listed in the shortcuts table. Only submitting the sentence calls the translation service; this does not access the microphone.

<a id="services"></a>
## 2. Configure the two services

Open **设置 → 服务连接** (Settings → Service connections). Speech recognition and caption translation are configured independently. Even if you use the same provider for both, check that each endpoint, model, and key matches the corresponding service.

| Field | Default / explanation |
| --- | --- |
| **语音识别 API Key** (Speech recognition API key) | Your DashScope key. Do not expose it in screenshots, logs, or issues. |
| **识别模型** (Recognition model) | `qwen-audio-3.1-asr-flash-streaming`. The default configuration omits a language hint so recognition can detect the language automatically. |
| **识别服务地址** (Recognition endpoint) | Beijing-region `wss://dashscope.aliyuncs.com/api-ws/v1/inference`. Custom endpoints must use WSS. |
| **翻译 API Key** (Translation API key) | Your translation service key. DeepSeek is the default; enter this separately from the recognition key. |
| **翻译模型** (Translation model) | Defaults to `deepseek-flash`; the client disables thinking mode to reduce waiting. |
| **翻译服务地址** (Translation endpoint) | Defaults to `https://api.deepseek.com`, using an OpenAI-compatible chat API. HTTPS is required; local services may use HTTP. |

Custom ASR endpoints must support the Qwen streaming/realtime protocols implemented by this app. An arbitrary WSS service is not automatically compatible.

Click **保存设置** (Save settings). Leaving a key field blank keeps the existing key. The interface shows only whether a key is configured, never its decrypted value. Saving successfully does not prove that your account can call the selected model; check account permissions, balance, and network access as well.

**Speech recognition, translation, retranslating, and Japanese furigana may all incur API charges.** Translating only selected languages reduces unnecessary requests but does not guarantee free use. Pricing, model availability, and data handling rules are determined by the provider. References: [Qwen real-time recognition](https://help.aliyun.com/en/model-studio/real-time-speech-recognition-user-guide), [DeepSeek API](https://api-docs.deepseek.com/api/create-chat-completion/).

Mac also offers **导入语音识别密钥** (Import speech recognition key). It reads one fixed local Keychain entry only when you explicitly click it. This updates recognition settings only, leaving the translation service unchanged. Windows does not offer this feature; enter the key manually.

<a id="audio"></a>
## 3. Choose audio sources and grant permissions

| Source | What is captured | Suggestions |
| --- | --- | --- |
| **电脑声音** (Computer audio) | The mixed audio stream from the system's default output device when capture starts | Play the audio you want to study and confirm the correct output device. |
| **麦克风** (Microphone) | The device selected under **服务连接 → 麦克风** (Service connections → Microphone), or the default system microphone | You can choose a specific device while idle or paused. Refreshing devices only queries the list; it does not start recording. |
| **双音源** (Both sources) | Independent recognition sessions for system audio and the microphone | Wear headphones to reduce duplicate pickup of speaker audio by the microphone. |

After choosing a source, click **开始聆听** (Start listening). A starting status does not mean captions are already available: you still need actual audio, a working account, and a service response. Recognition languages depend on the chosen ASR model; support for every language is not promised.

- **Windows microphone:** In Windows Settings → Privacy & security → Microphone, enable microphone access and allow desktop apps to access it. The category is called Privacy on Windows 10.
- **Windows computer audio:** WASAPI loopback captures audio only. It does not require screen recording permission and works independently of the microphone. Protected content, exclusive playback, or device limitations can make audio unavailable.
- **Mac:** Follow the system prompts to grant microphone or system audio recording permissions under System Settings → Privacy & Security. Computer audio uses Core Audio without capturing the screen. Exact setting names may vary by macOS version.

Audio source buttons are disabled while starting or listening; click **暂停** (Pause) before choosing a different source. Saving a change to the microphone device or service configuration pauses current listening. If the default device changes, the selected microphone is unplugged, or system output becomes unavailable, confirm the device and start again. The app does not silently switch to another physical device and continue recording. In both-source mode, failure of either source ends both.

Clicking **暂停** (Pause) ends capture and recognition while preserving the recognized part of an unfinished segment. Translation and furigana requests already submitted may still finish. Closing a panel, collapsing, or hiding the window does not pause capture. Quitting the app ends its process completely.

<a id="live"></a>
## 4. Translate as you listen, without waiting for long sentences to end

The app schedules a translation as soon as a usable partial transcript is available. The same segment continues to fill in as speech progresses, and the final recognition result corrects the translation afterward. Consecutive updates are combined to avoid sending a separate request for every character.

While a new translation is pending, the previous readable translation stays visible. The displayed original matches that version of the translation, while the untranslated continuation is indicated separately. New segments are appended in order; a late furigana result for an older segment does not pull the view backward.

Network conditions, provider buffering, and model inference all affect waiting time. Examples and synthetic tests do not guarantee real-world translation speed or accuracy.

<a id="languages"></a>
## 5. Caption languages and Japanese furigana

Open **设置 → 字幕语言** (Settings → Caption languages):

1. Choose **1–8** of the 20 available languages. Chinese, English, and Japanese are the defaults.
2. Use the left and right arrows beside selected languages to change their order. Only checked languages are translated. The first language also supplies previews in the history list.
3. **展开视图显示原文** (Show original in expanded view) affects only expanded mode. The compact window always keeps the original and all selected languages.
4. With Japanese selected, you can enable **日语汉字注音** (Japanese kanji readings). The translation appears first; the same translation model then generates readings from context and places them above the corresponding kanji.
5. Save settings. If an earlier segment lacks a newly selected language, retranslate it using the current language selection. Existing results are preserved.

Furigana never blocks the translation, and a failed reading request does not remove the Japanese text. Check personal names, words with multiple readings, and unusual expressions yourself. These readings are LLM output, not a dictionary or a guarantee of correct pronunciation.

If the Japanese translation is complete but its readings failed, choose **重试日语注音** (Retry Japanese readings). This retries only the readings, without retranslating or starting recording, including while paused. Japanese and furigana must remain enabled and the service must be configured. Retrying readings may still incur API charges. Canceling, changing languages, or leaving the Web page cancels pending manual reading requests.

<a id="history"></a>
## 6. Follow live captions, look back, save, and export

The view follows the **latest available translation** by default, without manual paging. While a new transcript is still untranslated, you can keep reading the previous segment. Partial translations of the current segment update in the same position as soon as they arrive.

- Scrolling, dragging the scrollbar, using reading navigation keys, or selecting text pauses following so you can look back and copy.
- Click **回到实时** (Back to live) to resume following. New captions continue arriving while you look back and are not discarded.
- Open **历史与收藏** (History and saved captions) to view recent segments or saved study captions. Select a segment to return to its reading position.
- Use the bookmark button to save a completed segment. Segments still being recognized, filled in, or translated cannot be saved yet.
- **导出收藏** (Export saved captions) exports Markdown containing the original, available translations, and any available Japanese readings. You are responsible for the exported files.
- A saved caption's retained translation remains exportable while a retry is pending or has failed. The button shows **正在导出…** (Exporting…) while busy; results appear only in history and remain available when you reopen it. Cancelling reports no success and leaves the collection unchanged; after a write failure, choose another destination and retry.
- The retranslate button on a segment calls the translation service with the current target languages and may incur additional charges.

### Local lookup

Current source includes local lookup. Earlier `main` preview packages lack it; use a successful build from the optimization PR or build a commit containing the change. A feature description does not establish hardware acceptance.

- Press `Ctrl+F` on Windows or `⌘F` on Mac inside the app to open **历史与收藏** (History and saved captions) and focus the search field. A compact window expands first. You can also open that panel to search.
- Look up literal text across locally retained originals, the original aligned with the last translation, and all existing translations, including languages currently hidden. Matching ignores case and normalizes Unicode forms, such as full-width and half-width characters. Search terms are not interpreted as regular expressions.
- Use **全部** (All) or **学习收藏** (Saved study captions) to filter results. In the search field, `Enter` / `Shift+Enter` cycles to the next / previous match. Click an entry to jump back to its caption segment.
- While the selected segment remains retained and matched, new captions or late translations keep the same segment selected and do not move the current reading position. Press `Esc` to close the panel and return focus to its invoking control. If compact expansion replaced it, focus goes to the equivalent expanded control. Settings and typed-text panels preserve the same return path.
- Lookup processes existing local text without additional API calls or retranslation. Search terms are not saved, and closing the panel clears the query. Evicted records and unsaved sessions from before the app was quit cannot be searched.

Regular sessions keep approximately the latest 150 sentences in memory and are not restored after you quit the app. Explicitly saved captions are stored locally, up to 1,000 sentences; these are not audio recordings.

<a id="window"></a>
## 7. Compact window, dragging, opacity, and shortcuts

![Synthetic example in the expanded view](images/expanded.png)

![Synthetic example in the compact window](images/compact.png)

*Both images were actually captured from the current LingoBar interface in Linux Chromium, using synthetic source text and French/Japanese translations. No audio was recorded and no services were called. They do not establish validation of native Windows window behavior or real DPI settings.*

Use **收起翻译条／展开翻译条** (Collapse/expand caption bar) at the top right to switch reading modes while keeping the current segment. Drag the compact window using its full **20px** top strip or the **8px** blank areas along the sides and bottom. Text, buttons, and scrollbars remain available for reading and interaction; they are not drag areas.

The compact window normally shows captions, with controls appearing on hover or keyboard focus. Long content is scrollable. While hovering, adjust background opacity from **45–100%**; it is saved automatically when released, and text remains clear. Font size is under **设置 → 显示与启动** (Settings → Display and startup). Toggle always-on-top directly in the main window. Mac also supports displaying the app across desktops.

| Action | Windows | Mac |
| --- | --- | --- |
| Show/hide the caption bar globally | `Ctrl+Alt+L` | `⌘⌥L` |
| Submit in the text input panel | `Ctrl+Enter` | `⌘ Enter` |
| Open local history lookup (requires a build containing this feature) | `Ctrl+F` | `⌘F` |
| Next / previous match in the search field | `Enter` / `Shift+Enter` | `Enter` / `Shift+Enter` |
| Close the current panel | `Esc` | `Esc` |
| Start/pause listening | Interface or tray menu | Interface or menu bar menu |

The close button hides the app to the tray on Windows or the menu bar on Mac. Click the icon to reopen it. If another app uses the shortcut, recover the window from that menu. Choose **退出 LingoBar** (Quit LingoBar) to exit. The app does not start audio capture automatically.

**Launch at login is prohibited.** Both new and legacy preferences stay off; the app cannot register or restore a login item. Startup and ordinary settings saves do not write OS login items. To handle a previous entry, explicitly choose **设置 → 显示与启动 → 移除语伴登录项** (Settings → Display and startup → Remove LingoBar login item). This affects only the app’s own user item, does not change system permissions, and reports an unconfirmed result without automatic retry. Other unsaved edits remain in the panel; actual system remnants require separate verification.

<a id="privacy"></a>
## 8. Keys, data, and privacy

| Data | Destination and retention |
| --- | --- |
| Microphone / computer audio | Sent over an encrypted connection to the configured ASR service after you start listening. The app does not save recordings. |
| Transcripts / typed text | Sent to the configured translation service for selected-language translations and optional Japanese furigana. |
| API keys | Encrypted in the main process with Electron `safeStorage`, using Keychain on Mac and DPAPI on Windows. Decrypted keys are not sent to the interface. Saving is refused if encryption is unavailable or fails, with no plaintext fallback. |
| Regular captions | Approximately the latest 150 sentences, kept only in session memory. |
| Saved study captions | Stored locally, up to 1,000 sentences, with Markdown export available on request. |

The data directory is `%APPDATA%\LingoBar` on Windows and `~/Library/Application Support/LingoBar` on Mac. Key encryption depends on the current operating system user. Copying the configuration directory to another computer or user account does not guarantee the keys can be decrypted.

Device-list queries let only the trusted main window query audio device status; they do not authorize capture. An actual `getUserMedia` request still requires a valid session started by the user. Camera requests and requests from untrusted pages or subframes are rejected. System privacy settings may still restrict device names or access.

Before sharing screenshots, logs, issues, or exported notes, remove keys, personal source text, captions, and recordings. Data received by service providers is subject to their terms.

<a id="troubleshooting"></a>
## 9. Troubleshooting

| Symptom | What to check first |
| --- | --- |
| Cannot select a microphone while idle | Check whether you installed the old `96b0b30` package. Replace it with a package from a newer successful CI build, refresh devices, and check system permissions. You do not need to start recording to unlock the device list. |
| No original captions | Check the audio source, actual audio, default output or microphone, OS permissions, ASR endpoint/model/key, and account permissions. |
| Originals appear but no translations | Check the translation service's separate key, endpoint, model, account balance, and network. It does not reuse the ASR key. |
| Only one source works, or captions are duplicated | Check both-source mode, microphone permission, and the current output device. Use headphones to reduce echo and duplicate pickup. |
| Capture stops after switching devices | Confirm the device and start again. This behavior explicitly ends the previous capture session. |
| Cannot save or unlock a key | Check system encryption services, the current OS account, and Keychain/DPAPI. Re-enter the key if needed; the app does not switch to plaintext storage. |
| Captions stay on an older segment | You may be looking back or have selected text. Click **回到实时** (Back to live). |
| Japanese translation appears without furigana | Check that Japanese is selected and readings are enabled. Wait or retranslate; a furigana failure does not affect the translation. |
| Cannot find the window, or the shortcut does not work | Reopen it from the tray or menu bar. Check whether another app uses `Ctrl+Alt+L` / `⌘⌥L`. |
| Installer download has expired | Artifacts are retained for only 14 days. Get a new package from a successful CI run on main, or build it using the README. |

<a id="validation"></a>
## 10. Version, tests, and reporting problems

Check fixes against the package's **commit ID**, not just version 0.1.5. Current test packages, checksums, and build results are available from [CI for the main branch](https://github.com/seihn2/lingobar/actions/workflows/build.yml?query=branch%3Amain). [PR #2](https://github.com/seihn2/lingobar/pull/2) retains the original commit and checksum records for the earlier verified test packages. See the [test matrix](windows-validation.md) for details.

Automation covers core state handling, partial translation, history following, furigana alignment, permissions and IPC, helper lifecycle, encryption failure, and packaged resources. Real Electron tests use two synthetic devices without fake UI auto-authorization. Window screenshots and 100% / 150% / 200% scaling checks also use synthetic scenarios.

**Validation on physical Windows 10/11 machines is not complete:** real computer audio/microphone/both-source capture, system privacy permissions, devices and drivers, the tray and shortcuts, old login-item removal, installation/uninstallation by a standard user, native dragging, real DPI settings, and multiple monitors remain unverified. This round of Mac CI also did not revalidate real audio capture, Keychain prompts, or real ASR/translation services. No paid APIs were called for testing. CI and synthetic results cannot replace these checks.

When reporting a problem, include the commit ID, OS version, devices, display scaling, audio source, reproduction steps, and expected/actual behavior: [Report an issue](https://github.com/seihn2/lingobar/issues). Do not include keys or private content. The project uses [CC BY-NC 4.0](../LICENSE); see [NOTICE](../NOTICE.md) for third-party sources.
