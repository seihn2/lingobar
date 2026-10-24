# macOS 离线验收：精确基线与组合范围

这份清单供父任务安排的独立 Mac 验证使用。云端研发与用户 Mac 验证分别记录；
已完成的 Mac 实机子集与尚未确认项目见 [验收记录](macos-validation.md)，
不能据此认定完整 Mac 或 Windows 10/11 实机通过；云端不操作用户 Mac。
不向提示、文件或日志传递密码；系统授权由用户在系统界面安全输入。

## 基线

| 范围 | 精确提交 | 生产 `src` Git tree |
| --- | --- | --- |
| 已合并 main | `857ec2c632b38b4ad50276be48524b2f8dc2571b` | Windows 移植基线，缺少下列两个 draft 改动 |
| PR #3：搜索／final 错误恢复 | `c7d737bdfdb8592f8fae18eb64f3ef06712f620b` | `a165814f24db3d3589b12b31c6798b0f77a855f8` |
| PR #3：已实机检查的离线预览 | `796a1aaef67b81e7df91e3109859daf73d2c755c` | `a165814f24db3d3589b12b31c6798b0f77a855f8` |
| PR #4：有界暂停／旧提示隔离 | `e1209b5de5b1d4984ee4d01943b943a0494cb39a` | `a1676fc1b60be531fbcb7185da948a5fda3b283c` |

本批 snapshot 提交仅增加测试、测量与文档，PR #3 的 `src` tree 保持上表不变。
本次 IPC 测量固定读取 C7，未将 PR #4 或临时组合冒称同一构建。两个 PR 仍独立、
未合并，任何单独包都不能称含有两者全部功能。Mac CI 曾完成 arm64 构建，
没有提供经过公证的 Mac 安装包。

## 下载离线预览，无需开发依赖

[PR #3](https://github.com/seihn2/lingobar/pull/3) 的成功 CI 现会保存
`LingoBar-macos-arm64-preview-…` artifact；具体 head、下载链接和校验值以该 PR
当前构建记录为准。登录 GitHub 下载并解开外层 artifact ZIP，得到：

- `LingoBar-0.1.5-macos-arm64-preview-<head前12位>.zip`：已构建的 `.app`，
  Apple Silicon／macOS 14.2+，无需安装 Node、npm、Xcode 或重新编译。
- `BUILD-MANIFEST.json`：PR head／base、CI 实际 checkout commit、生产源码 tree、
  archive hash、逐文件 hash／权限／符号链接、签名及合成自测状态。
- `SHA256SUMS.txt`：内层 ZIP 和 manifest 的校验值。GitHub 外层 artifact ZIP
  自己的 digest 另记在 PR，不与内层应用 ZIP 混用。

在这三个文件所在目录执行以下系统自带工具；这不会录音或访问服务：

```sh
shasum -a 256 -c SHA256SUMS.txt
ditto -x -k LingoBar-*-macos-arm64-preview-*.zip LingoBar-preview
codesign --verify --deep --strict LingoBar-preview/LingoBar.app
LingoBar-preview/LingoBar.app/Contents/Resources/native/system-audio-capture --self-test
```

helper 输出应为 `ok:true`、`captureStarted:false` 的 JSON。构建机已执行完整 ZIP
往返验证：每项文件内容、POSIX 模式与相对符号链接一致，解包后签名及 helper
合成自测通过。CI 保存应用前先用 `ditto` 归档，避免 artifact 直接上传目录时
丢失可执行权限；依据 [upload-artifact v4 文档](https://github.com/actions/upload-artifact/tree/v4#permission-loss)。

该预览沿用现有 **ad-hoc 签名，未经 Apple 公证**，不能等同 Developer ID 发布版。
不移除 quarantine，不重新签名，不关闭 Gatekeeper。系统若阻止打开，保留提示由
用户决定后续操作；云端不会替用户修改安全设置。父任务启动 UI 时使用新的
`LINGOBAR_TEST_DATA` 临时目录隔离已有配置，点击“看看示例”只显示内置合成内容；
不导入密钥、不点击开始收音、不提交文字翻译。

artifact 保留14天、不是正式 Release。本次仅保存 PR #3 的独立构建；没有把
PR #4 暂停改动纳入包，也没有新建组合包。两份源代码的组合回归仍按下节单独记录。

## 无音频／服务的测试入口

以下仅供开发者从源码复验，不是运行上述预览的前提。在独立 checkout 中核对
`git status`、提交和脚本后，使用锁定依赖。要求 Node
22.18+、Apple Silicon、macOS 14.2+、Xcode Command Line Tools；UI 测试使用
已安装 Chrome，找不到时报告缺项，不自动下载未知浏览器。

```sh
git switch --detach c7d737bdfdb8592f8fae18eb64f3ef06712f620b
git rev-parse HEAD HEAD:src
npm ci
npm test
npm run build
npm run test:ui
npm run test:media-permissions
npm run package:mac
resources/native/system-audio-capture --self-test
npm run verify:package
```

- `npm test` 的 fake socket／translator／PCM 合成用例不访问真实服务。
- UI fixture 使用合成字幕与生产 renderer，覆盖阅读跟随／回看、分段、振假名、
  透明度、紧凑模式，以及搜索时新增100条、延迟译文、清空历史、组合输入和 Esc 焦点。
  已实机预览796a1aa的CI为58检查×3个模拟缩放；39c6ba5为62×3，当前面板回归为85×3。
  这些是浏览器模拟，不是原生 DPI／输入法实机证明。
- Electron 权限测试为25检查，使用 fake devices 且不启用 fake UI auto-grant。
  覆盖 idle 枚举选设备、选择后开始、暂停／取消后重开与重新枚举、拒绝权限，
  以及未经主动开始、子框架、不可信来源和摄像头的拒绝。
- native `--self-test` 在创建 HAL 采集对象之前分流，只用合成 PCM；不启动系统收音。
- 不填 API Key、不导入本地密钥、不上传音频或字幕。通过这些用例不代表真实收音、
  provider final 或实际译文质量已经验收。

若要运行本批 snapshot 脚本，先检出包含本文件的 PR #3 精确 head 并记录
`git rev-parse HEAD`；C7 本身还没有新增的 benchmark 命令。运行
`npm run benchmark:snapshot:serialization` 和 `npm run benchmark:snapshot:ipc`，
结果分别记录 Mac 运行时，不能用 Linux 报告的耗时替代。基准仍读取 pinned C7 源码。

## 组合 PR #3 与 PR #4

只在干净、一次性 worktree 合并两个精确提交，**不提交、不 push、不改远程 main**。
父任务先记录实际 PR #3 head，再使用该 head 代替下例 C7；本批生产 tree 等价。

```sh
git switch --detach c7d737bdfdb8592f8fae18eb64f3ef06712f620b
git merge --no-commit --no-ff e1209b5de5b1d4984ee4d01943b943a0494cb39a
git diff --cached --stat
npm test
npm run build
npm run test:ui
npm run test:media-permissions
git merge --abort
```

云端 C7＋E120 曾通过303 Vitest＋7 reading、210 UI、25 Electron fake-device；
本批重新组合验证的范围在 PR 描述中记录。Mac 需另记平台、版本、架构和实际输出。
重点检查：搜索保持选中 ID／滚动锚点及焦点；暂停时立即停采集、至多等待2秒保留尾句；
暂停等待中开历史、重启、出现新错误时旧 timeout／rejection 不覆盖新提示；
退出／故障／权限撤销立即硬取消，旧回调不能复活；双源故障语义维持原行为。
这些由合成用例覆盖，真实音频／服务部分保持“未验证”。

人工查看打包 UI 时，使用全新的 `LINGOBAR_TEST_DATA` 临时目录隔离已有资料；
仅检查窗口、菜单、拖动、透明度和退出，不点击开始收音或输入真实凭据。
实际麦克风／系统权限、真实快捷键／原生 IME、采集和服务验收若另行安排，
必须由父任务分别确认并记录，不能因离线步骤通过而自动执行。
