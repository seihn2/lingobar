# LingoBar · 语伴

独立的 macOS / Windows 常驻桌面翻译条。将电脑声音、麦克风或手动输入的句子翻译为用户选择的语言，帮助逐句对照学习。默认中文、英文和日语，可从 20 种语言中选择 1–8 种并调整顺序，也可隐藏展开视图中的原文或关闭日语注音。视觉参考 Penumbra，应用、配置、收藏和安装包均独立。

支持 macOS（Apple Silicon，14.2+）和 Windows 10/11 x64。Windows 版通过 GitHub Actions 构建 NSIS 安装包，作为 PR 的测试 artifact 提供，尚未完成 Windows 音频与 DPI 实机验收，未经代码签名。构建与验证边界见 [Windows 移植说明](docs/windows-port.md) 和 [测试矩阵](docs/windows-validation.md)。

## 使用

1. macOS 打开 `LingoBar.app`；Windows 安装后从开始菜单打开 LingoBar。进入右上角设置。
2. 配置语音识别与翻译服务。语音识别默认使用北京区 DashScope 的 `qwen-audio-3.1-asr-flash-streaming`；翻译默认使用 DeepSeek 的 `deepseek-flash`，关闭思考模式以减少字幕等待时间。两个服务分别填写各自的 API Key。macOS 也可以点击“导入语音识别密钥”，读取此前为本机 Rokid 翻译器保存的 DashScope 密钥；此操作只配置语音识别，不改变翻译服务。已有自定义配置会保留。
3. 选择电脑声音、麦克风或双音源，点击“开始聆听”。macOS 首次使用时需要授予对应的音频权限，系统声音使用音频专用 Core Audio 采集。Windows 系统声音使用 WASAPI loopback，采集系统默认输出设备，不需要屏幕录制或麦克风权限；麦克风需要允许桌面应用访问。在设置 → 服务连接中可选择麦克风设备或跟随默认设备。切换音源、设备或服务配置会暂停聆听；默认设备变化或拔插时请确认设备后重新开始。两种平台均不采集画面。
4. 在“字幕语言”中选择目标语言与显示顺序。只翻译勾选的语言。原文识别出一部分就开始翻译，同一语段的译文随讲话持续补全，说完后再校正最终版本。连续的识别更新会合并处理，避免每个字都调用翻译；网络尚未返回时保留已经能读的译文。选中日语时，先显示译文，再由同一个翻译模型结合语境补上振假名。汉字位置由程序固定，模型只返回对应读音；注音失败不会撤掉译文。多音词及人名的读音仍需结合语境核对。历史语段可以按当前语言组合重新翻译，已有翻译保留。
5. 新语段按顺序追加，增量译文在同一位置更新，原文与译文始终对应同一版识别片段。默认立即跟随最新已有译文的段落，不等待旧段注音或额外停留时间；当前段落说话过程中持续更新译文。滚动或选中文字可暂停跟随，点击“回到实时”继续接收最新译文；历史段落与尚未译出的新内容分别保留。收藏的语段可以从“历史与收藏”导出 Markdown 学习笔记。悬停小窗可直接调节背景不透明度（45–100%），文字保持清晰，设置自动保存。
6. 收起后是轻量字幕窗，平时只显示原文和勾选的全部语言，并保留日语注音；鼠标移入或键盘聚焦后显示控制按钮。字幕字号和间距更紧凑，窗口按内容调整高度；长内容可滚动阅读。展开与收起切换时继续阅读同一语段。

小窗顶部整条 20px 区域和两侧、底部的 8px 空白可拖动窗口；字幕正文仍支持选择和滚动。鼠标移入时顶部显示淡淡的抓取提示。

关闭按钮隐藏到菜单栏（macOS）或系统托盘（Windows）；点击图标可再次打开。全局快捷键 **⌘⌥L**（macOS）或 **Ctrl+Alt+L**（Windows）显示或隐藏翻译条；冲突时可从托盘操作。应用支持置顶、拖动、调整大小、收起、背景透明度、字号和可选开机启动；macOS 还支持跨桌面显示。

首次打开不会自动收音。“看看示例”只演示布局，不调用服务。识别范围取决于所选 ASR 模型支持的语言，并非承诺识别世界上所有语言。默认模型省略语言提示，以便自动识别。双音源时建议使用耳机，减少电脑扬声器被麦克风重复收录。

## 数据与服务

- 语音通过加密连接发送到配置的识别服务；原文发送到翻译服务，服务可能产生 API 费用。
- 密钥使用 Electron safeStorage 加密（macOS 钥匙串 / Windows DPAPI），只在主进程解密，不回传给界面。加密不可用或失败时拒绝保存，不退回明文；Windows 加密绑定当前系统用户。
- 不保存录音。普通会话仅保存在内存中（最近约 150 句）；主动收藏的内容本地保存，上限 1000 句。
- 数据目录：macOS `~/Library/Application Support/LingoBar`，Windows `%APPDATA%\LingoBar`。应用标识：`com.lingobar.app`。
- 暂停会立即结束采集与识别，保留已识别的未完片段并完成它的翻译；已经提交的翻译和注音可继续完成。重新启动不会自动恢复收音。
- 本机密钥导入仅在 macOS 主动点击时读取固定的钥匙串项目，不扫描其他应用配置；Windows 不显示也不允许调用此入口。

## 开发与构建

共用工程需要 Node.js 22.18+（建议 Node.js 22 LTS）和 npm。macOS 构建需要 Apple Silicon Mac、macOS 14.2+、Xcode Command Line Tools。

```sh
npm ci
npm run build:native
npm run dev
```

```sh
npm test
npm run package:mac
```

应用输出到 `dist/mac-arm64/LingoBar.app`。本地版本使用 ad-hoc 签名，未经 Apple 公证；重新构建后系统可能需要重新授权。

Windows x64 构建需要 Windows 10/11、Visual Studio 2022 C++ Desktop tools（含 Windows SDK）、CMake 3.24+：

```powershell
npm ci
npm test
npm run typecheck
npm run package:win
npm run test:windows-native
npm run verify:package
npm run checksums:win
```

输出：`dist/LingoBar-0.1.5-windows-x64-setup.exe`；校验：`dist/SHA256SUMS.txt`。
`npm run dev` 使用 `resources/native/win-x64/system-audio-capture.exe`，运行前先执行
`npm run build:icons` 与 `npm run build:native`。安装包将 helper 放入固定的
`resources/native/system-audio-capture.exe`，不从 PATH 下载或搜索。

[Desktop CI](.github/workflows/build.yml) 使用公开仓库的标准 Windows / macOS / Ubuntu
runner，权限仅为 contents:read，不发布 release。Windows job 生成保留 14 天的
`LingoBar-windows-x64-<commit>` artifact；从 PR Checks → 对应 workflow → Artifacts
下载，内含安装包与 SHA256SUMS。过期后需重新构建。Windows ARM64 尚不支持。

`npm run test:ui` 使用已安装的 Chromium/Chrome/Edge（可设置 `CHROMIUM_PATH`），
只运行合成字幕，不访问音频和服务。会生成 `artifacts/ui-regression/` 证据；浏览器
缩放模拟不能代替 Windows 多显示器或 DPI 实测。

## 验证边界

自动测试覆盖翻译 JSON 校验、取消与超时、音频会话生命周期、PCM 分帧、麦克风重采样、队列乱序、收藏保存失败和设置恢复。原生组件的 `--self-test` 使用合成数据，不录音。界面示例和这些测试均不能代替真实账户、系统授权及实际音源的端到端验收。

接口依据：[Qwen 实时识别](https://help.aliyun.com/en/model-studio/real-time-speech-recognition-user-guide)、[DeepSeek 接口](https://api-docs.deepseek.com/api/create-chat-completion/)、[DeepSeek 模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。

## 来源

系统音频采集组件、帧协议与相关生命周期处理改编自 [Penumbra](https://github.com/seihn2/penumbra)，遵循仓库提供的 CC BY-NC 4.0 许可。LingoBar 的界面、多语翻译和学习收藏在本工程独立实现。改编范围与第三方声明见 [NOTICE.md](NOTICE.md)。

## 许可

本项目以 [CC BY-NC 4.0](LICENSE) 公开源码：允许在署名、保留许可及注明修改的前提下进行非商业使用、修改和分享。商业用途需另行取得相应权利人的授权。第三方依赖保留各自许可。

由于限制商业用途，本项目属于非商业许可的源码公开项目，不属于 [OSI 定义的开源许可](https://opensource.org/osd)。公开仓库不附带 API 密钥、录音、个人字幕或收藏；使用者需要自行配置服务账户。
