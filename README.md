<div align="center">
  <img src="build/icon.png" width="96" alt="LingoBar 图标">
  <h1>LingoBar · 语伴</h1>
  <p><strong>听见一句，看懂几种语言。</strong><br>轻量、常驻桌面的多语对照字幕条。</p>
  <p><strong>简体中文</strong> · <a href="README.en.md">English</a> · <a href="README.ja.md">日本語</a></p>
  <p>macOS 14.2+ · Windows 10/11 x64 · 0.1.5 · CC BY-NC 4.0</p>
</div>

[使用指南](docs/usage.zh-CN.md) · [安装与下载](#install) · [开发与构建](#development) · [验证范围](#validation)

LingoBar 将电脑声音、麦克风或手动输入的文字翻译为你选择的语言，方便逐句对照学习。原文识别出一部分就开始翻译；日语振假名随后补到对应汉字上方。默认跟随最新已有译文，也能随时停下来回看。

这是独立应用：配置、收藏和安装包均归属 LingoBar。界面目前以简体中文为主，文档提供中、英、日三种语言；字幕语言另行选择。

![LingoBar 展开视图的合成字幕示例](docs/images/expanded.png)

*当前界面在 Linux Chromium 中实际捕获的合成示例，选择法语与日语。不是 Windows 实机收音截图；没有调用语音或翻译服务。*

## 可以怎样用

- 从 20 种语言中选择 1–8 种并排序，默认中文、英文、日语；只翻译勾选的语言。
- 使用电脑声音、麦克风或双音源；长句讲话过程中，原文和译文在同一语段持续补全。
- 日语译文先显示，再由同一翻译模型补振假名；注音失败不会撤掉译文。
- 展开阅读或收起成小窗，保留原文、全部所选语言、文字选择和历史回看。
- 置顶、背景不透明度、字号、宽拖动区、托盘和可选登录启动；收藏可导出 Markdown。

<a id="install"></a>
## 安装与下载

| 平台 | 获取方式与要求 |
| --- | --- |
| Windows | Windows 10/11 **x64**。从 [Draft PR #2](https://github.com/seihn2/lingobar/pull/2) 的最新成功 CI 下载测试 artifact，解压后运行 `LingoBar-0.1.5-windows-x64-setup.exe`。包内有 `SHA256SUMS.txt`。 |
| macOS | Apple Silicon、macOS 14.2+。目前按下方命令从源码生成 `LingoBar.app`；仓库没有正式 release 下载。 |

Windows 测试包**未签名**、暂不支持 Windows ARM64。Mac 本地包为 ad-hoc 签名，未经 Apple 公证。安装前核对来源和校验值；[CI 构建记录](https://github.com/seihn2/lingobar/actions/workflows/build.yml?query=branch%3Acodex%2Fwindows) 不等于实机验收。

Artifact 需要登录 GitHub 下载，保留 14 天，过期后需从新的成功构建获取或自行构建。**旧提交 `96b0b30` 的安装包存在闲置时无法选择具体麦克风的问题，请使用 PR 中最新替代包。** 修复基线为 `f7a64b8` 及其后续提交；升级前先从托盘／菜单栏退出 LingoBar，再安装或替换新版。本分支仍在 draft PR 中，未合并、未部署、未发布正式 release。

## 五步开始

1. 打开应用，先点“看看示例”熟悉布局；示例不录音、不调用服务。
2. 进入 **设置 → 服务连接**，分别填写语音识别和翻译服务的地址、模型与各自的 API Key，点击 **保存设置**。
3. 选择电脑声音、麦克风或双音源。可在开始聆听前选择具体麦克风；枚举或刷新设备不会开始录音。
4. 进入 **设置 → 字幕语言**，选择和排序语言；需要时开启 **日语汉字注音**。
5. 点击 **开始聆听**。回看时滚动或选择文字，点 **回到实时** 恢复跟随。结束收音请点 **暂停**；隐藏窗口不会暂停。

语音识别默认使用 DashScope 北京区 `qwen-audio-3.1-asr-flash-streaming`；翻译默认使用 DeepSeek `deepseek-flash`，客户端关闭思考模式以减少等待。两个服务分别配置密钥，账户需具备相应模型权限。**在线识别、翻译和注音可能产生 API 费用**；延迟和可识别语言取决于网络、设备与所选模型。

详细的服务字段、系统权限、窗口操作和排错见 [完整使用指南](docs/usage.zh-CN.md)。

## 小窗与快捷键

![LingoBar 小窗的合成示例](docs/images/compact.png)

*同一当前界面的合成字幕小窗；真实窗口拖动、不同 DPI 与硬件音频仍需实测。*

小窗顶部 20px、两侧和底部 8px 空白可拖动；正文可选择、滚动。移入鼠标或键盘聚焦后显示控件。背景不透明度为 45–100%，文字保持清晰。

| 操作 | Windows | macOS |
| --- | --- | --- |
| 显示／隐藏翻译条（全局） | `Ctrl+Alt+L` | `⌘⌥L` |
| 提交手动文字（输入面板内） | `Ctrl+Enter` | `⌘ Enter` |
| 开始／暂停 | 界面或托盘菜单 | 界面或菜单栏菜单 |

快捷键被占用时可从托盘／菜单栏找回窗口。关闭按钮会隐藏应用；要结束应用，使用菜单中的 **退出 LingoBar**。

## 数据与隐私

- 首次打开不会自动收音，登录启动也不会自动恢复聆听。电脑声音仅采音频，不采画面；Windows 使用 WASAPI loopback，Mac 使用 Core Audio。
- 开始聆听后，音频经加密连接发往配置的识别服务；识别原文或手动文字发往翻译服务。服务方的数据处理条款另行适用。
- 密钥由主进程通过 Electron `safeStorage` 加密（Mac 钥匙串／Windows DPAPI），不回传界面；加密不可用或失败时拒绝保存，不退回明文。
- 不保存录音。普通会话仅在内存中保留最近约 150 句；主动收藏在本地保存，上限 1000 句，可导出 Markdown。
- 数据目录：Mac `~/Library/Application Support/LingoBar`；Windows `%APPDATA%\LingoBar`。应用标识为 `com.lingobar.app`。
- Mac 的“导入语音识别密钥”仅在主动点击后读取固定的本机钥匙串项目。Windows 隐藏并拒绝此入口。

<a id="development"></a>
## 开发与构建

共用工程使用 Node.js **22.18+**（建议 22 LTS）和 npm。先阅读脚本；使用 `npm ci` 保持依赖锁定。

```sh
git clone https://github.com/seihn2/lingobar.git
cd lingobar
git switch codex/windows
npm ci
npm test
npm run typecheck
```

| 平台 | 构建依赖 | 打包命令 | 输出 |
| --- | --- | --- | --- |
| macOS | Apple Silicon、macOS 14.2+、Xcode Command Line Tools | `npm run package:mac` | `dist/mac-arm64/LingoBar.app` |
| Windows x64 | Windows、CMake 3.24+、Visual Studio 2022 C++ Desktop tools 与 Windows SDK | `npm run package:win` | `dist/LingoBar-0.1.5-windows-x64-setup.exe` |

开发启动前先运行 `npm run build:native`；Windows 还需 `npm run build:icons`，然后运行 `npm run dev`。原生组件须在目标平台构建。

| 检查 | 命令 |
| --- | --- |
| 生产构建与类型检查 | `npm run build` |
| 真实 Electron 合成设备权限链 | `npm run test:media-permissions` |
| Chromium 合成字幕 UI（需已有浏览器） | `npm run test:ui` |
| 打包后 Windows helper 合成自测 | `npm run test:windows-native` |
| 包内容、资源与第三方声明 | `npm run verify:package` |
| Windows 安装包 SHA-256 | `npm run checksums:win` |

<a id="validation"></a>
## 版本与验证范围

当前代码版本为 **0.1.5**，功能和修复以提交号为准。Windows、macOS、Ubuntu CI 会运行真实 Electron 的合成设备权限测试；它不使用 fake UI 自动授权，也不访问真实麦克风、个人音频或付费 API。

Windows 10/11 实机收音、设备与系统权限、托盘／快捷键、登录启动、普通账户安装／卸载、原生拖动和真实 100%／150%／200% DPI **尚未验收**。浏览器缩放模拟和 CI 编译成功不能代替这些检查。Mac 本次 CI 也未重验实际收音、钥匙串提示或真实服务端到端流程。

参见 [测试矩阵](docs/windows-validation.md)、[Windows 移植说明](docs/windows-port.md)。报告问题请附提交号、系统、设备、显示缩放及复现步骤，先移除密钥、个人字幕和录音：[Issues](https://github.com/seihn2/lingobar/issues)。

## 来源与许可

音频组件、帧协议和部分生命周期处理改编自 [Penumbra](https://github.com/seihn2/penumbra)；LingoBar 的多语学习界面与收藏独立实现，具体来源提交和修改范围见 [NOTICE.md](NOTICE.md)。截图来自本工程的合成界面测试。

项目采用 [CC BY-NC 4.0](LICENSE)：允许在署名、保留许可并注明修改的前提下进行非商业使用、修改与分享；商业用途需另行授权。第三方依赖保留各自许可。这是非商业许可的源码公开项目，不属于 OSI 定义的开源许可。
