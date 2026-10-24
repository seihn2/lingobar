# macOS 离线验收：精确基线与组合范围

这份清单供父任务安排的独立 Mac 验证使用。云端研发与用户 Mac 验证分别记录；
此文档不代表已经操作 Mac，也不代表 Windows 10/11 实机通过。
不向提示、文件或日志传递密码；系统授权由用户在系统界面安全输入。

## 基线

| 范围 | 精确提交 | 生产 `src` Git tree |
| --- | --- | --- |
| 已合并 main | `857ec2c632b38b4ad50276be48524b2f8dc2571b` | Windows 移植基线，缺少下列两个 draft 改动 |
| PR #3：搜索／final 错误恢复 | `c7d737bdfdb8592f8fae18eb64f3ef06712f620b` | `a165814f24db3d3589b12b31c6798b0f77a855f8` |
| PR #4：有界暂停／旧提示隔离 | `e1209b5de5b1d4984ee4d01943b943a0494cb39a` | `a1676fc1b60be531fbcb7185da948a5fda3b283c` |

本批 snapshot 提交仅增加测试、测量与文档，PR #3 的 `src` tree 保持上表不变。
本次 IPC 测量固定读取 C7，未将 PR #4 或临时组合冒称同一构建。两个 PR 仍独立、
未合并，任何单独包都不能称含有两者全部功能。Mac CI 曾完成 arm64 构建，
没有提供经过公证的 Mac 安装包。

## 无音频／服务的测试入口

在独立 checkout 中核对 `git status`、提交和脚本后，使用锁定依赖。要求 Node
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
  PR #3 为58检查×3个模拟缩放；这是浏览器模拟，不是原生 DPI／输入法实机证明。
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
