# Windows 版开发任务

状态：Windows x64 实现已在 `codex/windows` 分支落地，包含原生 helper、平台适配、NSIS 安装包和合成 CI；仍需 Windows 实机验收。实际证据和未验证项见 [测试矩阵](windows-validation.md)。现有 macOS 应用与 Windows 版共用 Electron / React / TypeScript 工程；不修改 Penumbra。

## 已有可复用基础

[Penumbra](https://github.com/seihn2/penumbra) 已有 `resources/native/windows/SystemAudioCapture.cpp`、`AudioFrame.h`，以及 `scripts/build-windows-wheel-monitor.cjs`、`scripts/verify-windows-system-audio.cjs`。可按 CC BY-NC 4.0 引入音频相关部分并记录具体来源提交，不带入无关的鼠标组件。现有实现采用 WASAPI loopback，帧协议与本项目一致；但已有源码不能作为 Windows 编译或实机验收通过的证据，仍需完整验证。

## 用户体验

- 原文加上用户勾选的 1–8 种目标语言，默认中文、英文、日文。
- 电脑声音、麦克风或双音源；识别到长句的中途片段即翻译，同一段持续更新。
- 默认显示当前最新译文；用户主动回看时才暂停跟随，支持返回实时。
- 日语振假名由 LLM 生成，标在对应汉字上方；译文先到先显示，注音不能阻塞它。
- 轻量悬浮窗、宽拖动区、置顶、透明度、缩放、托盘；开机启动保持禁用。文字可选择，按钮与滚动条不能变成拖动区域。

## 实现范围

1. 新增 Windows WASAPI loopback 原生采集器，优先支持 Windows 10/11 x64，明确最低系统版本。系统声音必须独立于麦克风，也不需要屏幕采集；处理默认输出设备变化、静音、拔插及权限错误。
2. 复用 `src/main/audio/native-protocol.ts` 和 `native-capture.ts` 的受限子进程协议。标准输出仅发送 `PCM1` + 32 位小端长度 + PCM 帧，16000 Hz、单声道、16-bit little-endian、每帧不超过 8192 字节；标准错误发送已有 JSON 控制消息。遵守 ready/activate/stop 生命周期、父进程退出清理和背压。实现前以现有源文件为准核对全部协议细节，不猜测命令。
3. 增加原生 Windows 构建脚本，开发路径保持 `resources/native/win-${process.arch}/system-audio-capture.exe`，打包路径为 `resources/native/system-audio-capture.exe`。禁止从 PATH 或远程位置任意查找可执行文件。
4. 适配 `scripts/sign-mac.cjs` 的平台判断及 electron-builder Windows 安装包、图标与资源；macOS 原有构建必须继续通过。提供可复现的 Windows 构建命令及 CI，先不承诺 ARM64。
5. 用 Windows 支持的 Electron safeStorage 保存密钥。隐藏 macOS 钥匙串导入入口；加密不可用时给出明确错误，不能退回明文。启动、托盘、快捷键、权限提示使用对应平台的表达。
6. 原文、翻译调度、语言选择、LLM 注音及默认模型与 macOS 共用；任何平台适配不得退回“等说完才翻译”或由用户手动翻页的交互。

## 验收

- `npm test`、`npm run typecheck`、macOS 构建继续通过。
- Windows CI 编译原生组件、运行合成音频自测、生成安装包，保留构建日志。
- Windows 实机验证系统声音 / 麦克风 / 双音源、开始暂停和退出、设备切换、静音、连续长句的中途译文、默认实时跟随、文字选择和悬浮窗拖动。
- 在 100% / 150% / 200% DPI 下检查振假名、窗口尺寸和控件命中。
- 密钥和真实语音、字幕、个人设置不写入仓库、CI 日志或安装包。CI 成功不能替代实机验收；没有实机环境时必须标明未验证项目。

在独立 `codex/windows` 分支提交并开 PR，说明实际完成范围、构建结果和仍需实机验证的事项。保留 CC BY-NC 4.0 及第三方许可声明。


## 当前实现约定

- 最低目标为 Windows 10 x64；Windows 11 x64 共用安装包。Electron 运行时不支持 Windows 7/8，尚不提供 Windows ARM64。
- helper 只采集系统默认 **输出** 设备的 shared-mode mix，不混入麦克风、不采屏幕。默认输出变化、设备失效或访问被拒时返回受限错误码并终止本次聆听；用户确认设备后重新开始，不自动跨物理设备继续收音。
- 麦克风在设置的“服务连接”中选择设备；更改设置立即使旧 run 失效。默认设备变化或所选设备拔出会暂停，晚到的授权结果释放所有 tracks。双音源保持独立 ASR 会话，任一路失败会同时结束两路。
- `ready` 是 helper 已启动设备的控制消息；`activate` 是主进程在识别会话就绪后释放有界缓存的方法，不是 stdin 文本命令。stdin 关闭是停止信号；父进程退出和管道背压都有独立 watchdog，强制退役有界。
- Windows 托盘使用现有 LingoBar 图形，快捷键 Ctrl+Alt+L；密钥由系统 DPAPI 提供的 safeStorage 加密，无法加密时拒绝保存。钥匙串导入仅在 macOS 可用。
- 原生构建需要 CMake 3.24+、Visual Studio C++ tools 与 Windows SDK。详细命令及安装包位置见 README。
- 安装包为未签名的 PR 测试版本，未设置自动更新或正式 release；不会合并、部署或升级付费 runner。
