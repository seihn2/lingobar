<div align="center">
  <img src="build/icon.png" width="104" alt="LingoBar 图标">
  <h1>LingoBar · 语伴</h1>
  <p><strong>把正在听的内容，变成可对照、可回看的多语字幕。</strong></p>
  <p>
    <a href="https://github.com/seihn2/lingobar/actions/workflows/build.yml?query=branch%3Amain"><img src="https://github.com/seihn2/lingobar/actions/workflows/build.yml/badge.svg?branch=main&amp;event=push" alt="构建与合成测试"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-CC%20BY--NC%204.0-blue.svg" alt="CC BY-NC 4.0"></a>
    <a href="package.json"><img src="https://img.shields.io/badge/version-0.1.5-6f42c1.svg" alt="版本 0.1.5"></a>
    <a href="package-lock.json"><img src="https://img.shields.io/badge/Electron-43.8.3-47848F.svg?logo=electron" alt="Electron 43.8.3"></a>
    <a href="package-lock.json"><img src="https://img.shields.io/badge/React-19.1.1-61DAFB.svg?logo=react&amp;logoColor=111" alt="React 19.1.1"></a>
  </p>
  <p><strong>简体中文</strong> · <a href="README.en.md">English</a> · <a href="README.ja.md">日本語</a></p>
</div>

[使用指南](docs/usage.zh-CN.md) · [安装](#install) · [快速上手](#quick-start) · [参与贡献](#contributing)

LingoBar 是面向语言学习的桌面字幕工具。它将电脑声音、麦克风或手动输入的文字翻译为所选语言，在轻量悬浮窗中并排呈现原文、译文和日语读音，方便边听边读、逐句复习。

项目基于 Electron、React 和 TypeScript，以 **CC BY-NC 4.0 非商业许可公开源码（source-available）**。应用界面目前主要为简体中文；中、英、日文档与可选的字幕输出语言是独立的。

<a id="validation"></a>
> [!IMPORTANT]
> **当前为开发预览，通过源码和 CI 测试包分发，尚无正式 release。** Windows 包未签名，Windows 10/11 的真实音频、设备和 DPI 体验仍待实机验收。构建通过不等于完成实机验证，详见 [验证范围](docs/windows-validation.md)。

![LingoBar 多语字幕界面](docs/images/expanded.png)

*当前界面的合成字幕示例，实际捕获于 Linux Chromium；不是 Windows 实机收音截图。[截图来源](docs/images/README.md)*

<a id="overview"></a>
## 功能概览

- **边听边对照。** 支持电脑声音、麦克风和双音源。长句识别到中途片段即开始翻译，在同一语段持续补全，适合课程、视频和口语练习。
- **按学习目标选择语言。** 从 20 种语言中选择 1–8 种并调整顺序，默认中文、英文、日语；只翻译所选语言。
- **把日语读音放回文字中。** 译文先显示，再由翻译模型结合语境补振假名，标在对应汉字上方；注音不阻塞阅读。
- **实时跟随，也能停下来读。** 默认显示最新已有译文；滚动或选择文字即可回看，点击“回到实时”继续跟随。
- **留下值得复习的句子。** 使用小窗、置顶、调节背景透明度和字号；收藏完成的语段，导出为 Markdown 学习笔记。
- **本地查找历史。** 当前源码支持原文与已有译文查找，可用 `Ctrl+F`／`⌘F` 打开；操作和范围见 [指南](docs/usage.zh-CN.md#history)。此前的 `main` 预览包不含此功能，请选用本次优化 PR 的成功构建，或从包含此改动的提交构建。

<a id="install"></a>
## 安装

| 平台 | 系统要求 | 获取方式 |
| --- | --- | --- |
| Windows | Windows 10/11，**x64** | [CI 测试包](https://github.com/seihn2/lingobar/actions/workflows/build.yml?query=branch%3Amain)：在对应成功构建的 Artifacts 中下载 ZIP，解压后运行安装程序。 |
| macOS | macOS 14.2+，Apple Silicon | [PR #3 离线测试包](docs/usage.zh-CN.md#install)，或[从源码构建](#development)。预览采用 ad-hoc 签名，未经 Apple 公证；PR #3 包不含 PR #4 改动。 |

Windows x64 支持已合并到 `main`；此前已验证测试包与校验记录见 [PR #2](https://github.com/seihn2/lingobar/pull/2)。Windows 暂不提供 ARM64 包。CI artifact 下载需要登录 GitHub，保留 14 天，过期后请使用新的成功构建或自行构建。安装前核对包内 `SHA256SUMS.txt`；具体安装、升级和系统授权步骤见 [使用指南](docs/usage.zh-CN.md#install)。

<a id="quick-start"></a>
## 快速上手

1. 打开 LingoBar，点击 **看看示例** 熟悉阅读方式。示例不收音、不调用服务。
2. 进入 **设置 → 服务连接**，分别配置语音识别与翻译服务，然后点击 **保存设置**。
3. 选择电脑声音、麦克风或双音源；需要时在设置中预选具体麦克风并保存。
4. 在 **设置 → 字幕语言** 中选择和排序语言，可开启 **日语汉字注音**，然后保存设置。
5. 点击 **开始聆听**。回看后用 **回到实时** 恢复跟随；结束收音请点击 **暂停**，隐藏窗口不会暂停。

全局快捷键：Windows **`Ctrl+Alt+L`**、Mac **`⌘⌥L`** 显示或隐藏翻译条。窗口的拖动区域、透明度、手动文字翻译和收藏操作见 [完整指南](docs/usage.zh-CN.md)。

<a id="configuration"></a>
## 服务配置

| 用途 | 默认服务与模型 |
| --- | --- |
| 实时语音识别 | DashScope 北京区，`qwen-audio-3.1-asr-flash-streaming` |
| 字幕翻译与可选日语注音 | DeepSeek，`deepseek-flash` |

两项服务分别填写 API Key，账户需有对应模型的使用权限。**在线识别、翻译和注音可能产生 API 费用。** 字幕语言选择不等于 ASR 能识别同样的全部语言，延迟与识别范围取决于网络、设备和模型。

完整字段、接入协议和权限说明见 [服务配置指南](docs/usage.zh-CN.md#services)。设备切换或连接故障可先查看 [排错表](docs/usage.zh-CN.md#troubleshooting)。

<a id="documentation"></a>
## 文档

桌面学习：[显式 AI 语境解释、独立学习历史与主动复习](docs/dictionary-learning.md)（当前 draft；生成内容可能不准确，真实词典导入未提供）。

| 语言 | 使用指南 |
| --- | --- |
| 简体中文 | [安装、配置与日常使用](docs/usage.zh-CN.md) |
| English | [Installation, configuration and everyday use](docs/usage.en.md) |
| 日本語 | [インストール・設定・使い方](docs/usage.ja.md) |

开发与平台资料：[Windows 移植说明](docs/windows-port.md) · [测试矩阵、已知限制与构建记录](docs/windows-validation.md) · [Mac 实机 UI 子集与待验收项](docs/macos-validation.md) · [第三方来源](NOTICE.md)。

<a id="development"></a>
## 开发与构建

需要 Node.js **22.18+** 和 npm。原生组件在目标平台构建：

| 平台 | 额外工具 |
| --- | --- |
| macOS | Apple Silicon、macOS 14.2+、Xcode Command Line Tools |
| Windows x64 | CMake 3.24+、Visual Studio 2022 C++ Desktop tools、Windows SDK |

`main` 已包含 Windows x64 支持。使用锁定依赖启动本地工程：

```sh
git clone https://github.com/seihn2/lingobar.git
cd lingobar
git switch main
npm ci
npm run build:icons
npm run build:native
npm run dev
```

| 命令 | 用途 |
| --- | --- |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm test` | 核心逻辑与状态回归 |
| `npm run build` | 类型检查与生产构建 |
| `npm run test:media-permissions` | 实际 Electron 的合成设备权限检查 |
| `npm run test:ui` | 已安装 Chromium 浏览器中的合成字幕交互检查 |
| `npm run test:dictionary-ui` | 严格词条、历史和复习的合成 DOM/可访问性树检查 |
| `npm run package:mac` | 构建 Mac 应用目录 |
| `npm run package:win` | 构建 Windows x64 NSIS 安装包 |

输出位于 `dist/`。原生 helper、包内容和校验清单的检查命令见 [构建与验证](docs/windows-validation.md)。

<a id="contributing"></a>
## 参与贡献

欢迎提交功能明确的修复、设备兼容性反馈、无障碍改进、测试和文档翻译。报告问题时，请提供提交号、系统版本、音源或设备、显示缩放、复现步骤，以及预期与实际表现：[GitHub Issues](https://github.com/seihn2/lingobar/issues)。

提交 PR 前运行 `npm run typecheck`、`npm test` 和 `npm run build`；行为变更请补充有意义的测试，并说明实际验证的平台。真实设备结果与合成测试应分开记录。截图、日志和测试 fixture 中不要包含密钥、录音或个人字幕。

<a id="privacy-license"></a>
## 隐私与许可

语伴不注册或恢复开机启动；旧配置的开启值也按关闭处理。启动与普通设置保存不修改系统登录项，旧版本残留仅在你明确选择移除时处理，实际系统状态仍需核对。

应用不会在首次打开时自动收音，也不保存录音。开始聆听后，音频通过加密连接发送到配置的识别服务；原文或手动文字发送到翻译服务。密钥由主进程通过 Electron `safeStorage` 加密，加密不可用或失败时拒绝保存，不退回明文。具体数据保留、系统权限与服务商边界见 [隐私说明](docs/usage.zh-CN.md#privacy)。

项目采用 [CC BY-NC 4.0](LICENSE)：允许在署名、保留许可并注明修改的前提下进行非商业使用、修改和分享；商业用途需另行授权。这是源码公开项目，并非 OSI 定义的开源软件。第三方依赖保留各自许可。

音频组件、帧协议及部分生命周期处理改编自 [Penumbra](https://github.com/seihn2/penumbra)。LingoBar 的多语学习界面与收藏独立实现，来源提交及修改范围见 [NOTICE.md](NOTICE.md)。
