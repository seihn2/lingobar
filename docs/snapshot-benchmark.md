# 全量 Snapshot 传递开销：预先预算与合成测量

本轮先测量，不修改生产 `snapshot()`、`publish()`、preload 或字幕 UI。纯序列化／克隆代理与真实 Electron IPC 分开报告，不能把 JSON/V8 的字节数称为 Mojo wire bytes 或网络流量。

## 数据采集前确定的工程预算

参考负载为 **150 条历史、3 种目标语言、每秒 20 次 partial，另加 1 条 live caption**；负对照为 0 条历史／1 种语言，压力负载为 1150 条历史／8 种语言／60 次 partial 每秒，1150 指 1000 条收藏加 150 条近期记录。

| 指标 | 预先预算 |
| --- | --- |
| 单次 encode／clone | p95 ≤ 2ms |
| 实际 main 每个 partial 累计 `publish()` 调用 | ≤ 4ms |
| 经 preload/contextBridge 到被动主世界 receiver 再返回 ACK | p95 ≤ 50ms |
| final／error／status 的 ACK | ≤ 100ms |
| 丢失 terminal event | 0 |
| 最后一条输入后的 drain | ≤ 250ms |

这些是排查问题的工程预算，不是用户 SLO、实机体验保证，也不是跨机器的 CI 硬阈值门禁。压力负载不自动套用参考负载的延迟保证。预算已在本轮首次计时前写入；后续数据不能反向调整预算以追求通过。

## 固定来源与共享 fixture

源码基线固定为 PR #3 的精确提交 `c7d737bdfdb8592f8fae18eb64f3ef06712f620b`，本轮不包含暂停收尾 PR #4 的生产改动。脚本记录基线关键源码 hash 和运行时版本。

[snapshot-fixtures.cjs](../test/benchmarks/snapshot-fixtures.cjs) 提供：

```js
const { makeSnapshot, serializationMatrix, matrix, budgets, fixtureMetadata } = require('./test/benchmarks/snapshot-fixtures.cjs')
const snapshot = makeSnapshot({ historyCount: 150, targetCount: 3, includeLive: true, revision: 0 })
```

- `historyCount` 为 0／150／1150，不包含额外 live。1150 时默认 1000 saved＋150 recent。
- `targetCount` 为 1／3／8。每条 caption 的目标数组、translations、legacy zh/en/ja 均独立且一致；settings 的目标数组另建，不与 caption 共用。
- 原文 96 个 UTF-16 code units，译文每语种 160；Unicode 不截断代理项，内容均为明确合成文字。含日语时只给少量合理的 ruby segments，拼回完整日文。
- `revision` 只改变稳定 ID 的 live 内容；可选 `state`、`message`、`originalUnits`、`translationUnits`、`savedCount`。不读配置、不含 API Key，两个密钥状态标志均为 false。
- 生产 Snapshot 本身没有 platform 字段；`fixtureMetadata.platform` 为 `synthetic`，实际机器／Electron 运行时版本单独记录。
- `serializationMatrix` 是 9 个历史／语言组合；`matrix` 再与 5／20／60Hz 组合成 27 行，供真实 IPC 阶段复用。

## 纯序列化／克隆代理

待测三种路径：`JSON.stringify` 后转 UTF-8 Buffer、`v8.serialize`、`structuredClone`。每行先做 5 次 warmup，再做 30 次真实 wall-clock 样本，记录 mean／p50／p95／max。JSON、V8 字节数以实际输出长度计；structuredClone 没有可报告的 wire payload bytes。

纯代理不调用 Electron、React、服务或音频；没有 ACK、IPC 排队或主进程 `publish()` 累计时间，因此不能用它判定上表的 IPC 预算。真实 Electron IPC 阶段将由独立 harness 经生产 main/preload 和被动 receiver 测量，不含 React DOM、硬件音频或服务调用。

Electron `v43.8.3` 的官方文档说明，`webContents.send` 的参数按 structured-clone 语义序列化；contextBridge 在跨 context 传递参数、返回值等数据时还涉及复制，函数则经代理调用。因此，下面的 Node 代理不是 Electron 实际 IPC encoding 的测量，不能将其时间相加来推算完整桥成本，也不把 V8 输出格式当作 Mojo wire 格式。[webContents 文档](https://github.com/electron/electron/blob/v43.8.3/docs/api/web-contents.md#contentssendchannel-args)、[contextBridge 文档](https://github.com/electron/electron/blob/v43.8.3/docs/api/context-bridge.md#parameter--error--return-type-support)。这里只引用功能约定，没有复制第三方实现代码。

## 纯代理结果

记录时间为 `2026-10-24T15:20:31.922Z`，环境为 Linux x64、Node.js `v24.19.0`、V8 `13.6.233.17-node.51`。Electron `43.8.3`／React `19.1.1` 只是当前工程的依赖版本；本表没有运行 Electron 或 React。

9 组 fixture × 3 种代理 = **27 行**；每行 5 次 warmup 后计时 30 次，共 **135 次 warmup、810 个计时样本**。fixture 检查、输出字节数计算和 roundtrip 校验不计入计时。测试顺序固定，未强制 GC、未删除 outlier。p50／p95 使用 nearest rank，30 个样本的 p95 为排序后的第 29 个。wall clock 包含分配、GC 与机器调度影响，不是纯函数理论下界；`process.cpuUsage` 的 user＋system 数据也保留在 CSV／JSON，它是进程级 CPU 代理，不是独占主线程计数。

| History | Targets | Total captions | Operation | Payload bytes | Mean ms | p50 ms | p95 ms | Max ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 1 | 1 | json-utf8 | 2015 | 0.033 | 0.011 | 0.144 | 0.226 |
| 0 | 1 | 1 | v8-serialize | 2000 | 0.009 | 0.009 | 0.014 | 0.019 |
| 0 | 1 | 1 | structured-clone | — | 0.019 | 0.010 | 0.093 | 0.105 |
| 0 | 3 | 1 | json-utf8 | 4146 | 0.030 | 0.021 | 0.097 | 0.171 |
| 0 | 3 | 1 | v8-serialize | 4096 | 0.028 | 0.016 | 0.044 | 0.262 |
| 0 | 3 | 1 | structured-clone | — | 0.060 | 0.013 | 0.471 | 0.865 |
| 0 | 8 | 1 | json-utf8 | 5786 | 0.158 | 0.024 | 0.099 | 3.797 |
| 0 | 8 | 1 | v8-serialize | 5776 | 0.019 | 0.008 | 0.044 | 0.206 |
| 0 | 8 | 1 | structured-clone | — | 0.027 | 0.016 | 0.080 | 0.190 |
| 150 | 1 | 151 | json-utf8 | 190965 | 1.908 | 1.435 | 3.867 | 5.969 |
| 150 | 1 | 151 | v8-serialize | 194702 | 0.630 | 0.589 | 1.168 | 1.340 |
| 150 | 1 | 151 | structured-clone | — | 0.688 | 0.429 | 1.943 | 2.090 |
| 150 | 3 | 151 | json-utf8 | 511396 | 4.926 | 3.334 | 7.053 | 41.743 |
| 150 | 3 | 151 | v8-serialize | 509998 | 1.301 | 1.483 | 2.440 | 2.648 |
| 150 | 3 | 151 | structured-clone | — | 5.221 | 1.118 | 2.835 | 117.688 |
| 150 | 8 | 151 | json-utf8 | 755286 | 4.567 | 3.845 | 7.627 | 8.137 |
| 150 | 8 | 151 | v8-serialize | 760678 | 1.397 | 1.290 | 3.509 | 3.680 |
| 150 | 8 | 151 | structured-clone | — | 2.010 | 1.320 | 4.808 | 5.429 |
| 1150 | 1 | 1151 | json-utf8 | 1449631 | 11.521 | 11.290 | 18.352 | 21.492 |
| 1150 | 1 | 1151 | v8-serialize | 1479368 | 2.801 | 2.073 | 5.545 | 11.278 |
| 1150 | 1 | 1151 | structured-clone | — | 5.101 | 4.266 | 10.075 | 13.312 |
| 1150 | 3 | 1151 | json-utf8 | 3892062 | 34.885 | 31.915 | 58.823 | 60.022 |
| 1150 | 3 | 1151 | v8-serialize | 3882664 | 5.752 | 4.276 | 14.841 | 18.654 |
| 1150 | 3 | 1151 | structured-clone | — | 11.491 | 11.219 | 20.480 | 21.434 |
| 1150 | 8 | 1151 | json-utf8 | 5750952 | 43.478 | 36.031 | 57.814 | 180.474 |
| 1150 | 8 | 1151 | v8-serialize | 5793344 | 7.867 | 6.038 | 14.795 | 25.361 |
| 1150 | 8 | 1151 | structured-clone | — | 10.008 | 9.224 | 15.505 | 16.079 |

这些精确 payload bytes 与该 fixture 和 Node 版本相关；`structuredClone` 返回对象而不是序列化 Buffer，所以它的 bytes 显示为 **—**。主表时间保留 3 位小数，原始 30 个样本与未四舍五入统计均在 `artifacts/snapshot-benchmark/serialization-results.json`，完整 CPU 和 wall 统计也在 `serialization-results.csv`。

以下只是“一次完整代理 payload × 每秒 partial 数”的算术换算，**不是实际发送频率、Mojo wire bytes/s 或网络吞吐**；真实 `publish()` 一次输入调用几次，须由 IPC 阶段计数。

| 场景 | 假设每秒次数 | JSON 代理 bytes／次 | V8 代理 bytes／次 | JSON 代理 bytes／s | V8 代理 bytes／s |
| --- | --- | --- | --- | --- | --- |
| 0 history／1 target／1 live | 5 | 2015 | 2000 | 10075 | 10000 |
| 150 history／3 targets／1 live | 20 | 511396 | 509998 | 10227920 | 10199960 |
| 1150 history／8 targets／1 live | 60 | 5750952 | 5793344 | 345057120 | 347600640 |

本次参考 fixture 的 wall p95 分别为 JSON UTF-8 **7.053ms**、V8 **2.440ms**、structuredClone **2.835ms**，高于预设的单 encode／clone 2ms 诊断预算。对应的进程 CPU p95 为 7.060／3.296／3.477ms；不据此断言 Electron 的实际 encode 已超预算。

全部样本保留，包括参考 fixture 的 structuredClone 最大 **117.688ms**、压力 fixture 的 JSON 最大 **180.474ms**；本轮没有定位这些长尾究竟来自 GC、分配或共享机器调度，不能擅自剔除，也不能将这一次运行的尾延迟推广到用户设备。

随着历史和已生成语言增加，完整 Snapshot 的代理体积和 CPU／wall 开销明显增长，值得继续用真实生产 `publish()`＋preload/contextBridge 结果检查是否存在瓶颈。此处的证据不足以决定节流频率、丢弃 partial、改增量协议或重写渲染；尤其不能用它推断 terminal event 会丢失。本轮保持生产行为不变，等待真实 IPC 表后再判断是否需要改动。

关键 pinned 源码 SHA-256（记录时工作区相同）：

| 文件 | SHA-256 |
| --- | --- |
| `src/shared/types.ts` | `67abe266ccea76a5d31170b7f23550cb4f1be22eebccbb8180392559265e0aaa` |
| `src/main/index.ts` | `710495425152101b773527a27cba5f81c20918b571162cda78a12400d96da58a` |
| `src/preload/index.ts` | `3537ed89b42b7c374e6736884091bfeb7effb0bf8258c65d203836b549b4562e` |
| 共享 fixture | `f7755f08d420e14f404dd3af311b3d3d28bbc68281a1042d39455266b5b654ea` |

计时前的预算章节 SHA-256 为 `0e0f76b77a81f870c8855c86ca2beab365bf1e196e3bfedd0bd8495a274ff30a`，保存在 `serialization-plan.json`；该章节未根据结果修改。脚本同时记录自身、依赖锁文件、Git blob 和全部相关版本。每种代理都验证输出 roundtrip、无输入改写、数组／translation 对象无意外共享，所有网络护栏计数为 **0**。

重现命令为 `node scripts/benchmark-snapshot-serialization.cjs`。它只写忽略的 `artifacts/snapshot-benchmark/`，不会自动修改本报告；重跑的真实耗时会变化，不能把单次数字作为跨机器 CI 门禁。代码与合成 fixture 沿用本项目 CC BY-NC 4.0；输出中保留项目 LICENSE／NOTICE。

## 真实 Electron IPC 结果

首次完整矩阵在 Linux x64 云容器执行，Electron **43.8.3**、Chromium **150.0.7871.250**、Electron 内置 Node **24.22.0**；CPU 报告为 Intel Xeon Platinum 8573C、5 个逻辑 CPU，内核 6.18.55。运行起止时间、实际机器信息、每个生产模块／harness／编译包 SHA-256 均保留在 `ipc-results.json`。共享容器没有 CPU 隔离，没有把 GC／调度长尾剔除。

### 方法与对照

- 读取 `git show c7d737b:src/...` 的完整实际模块，在临时 esbuild 输入末尾附加观察 hooks；实际 `snapshot()`、`publish()`、CaptionQueue、`onPartial` 和生产 preload/contextBridge 都被执行。没有另写一份发布逻辑来代替生产代码。
- AudioEngine 只捕获回调，stop 发出生产契约要求的 idle 回调；托盘、菜单、快捷键、显示器、剪贴板和导出为无副作用 facade。翻译器为可取消的 pending Promise，650ms 队列计时器保留。临时空 profile、无密钥，拒绝全部媒体权限，renderer 请求只允许测试的 127.0.0.1 origin。没有音频／设备／ASR／翻译服务调用。
- `baseline` 为原始生产路径。`single-publish-control` 仅在临时输入把非空 partial 后的第二次同步 `publish()` 去掉：`queue.updatePartial()` 已同步触发 changed → publish。空 partial 仍立即 publish，旧 utterance 的空 partial 仍提前返回。没有计时器、合帧、丢消息或增量协议，**该对照未写入 `src/`**。
- 27 个历史／语言／频率组合，每个 variant 各执行一个 1000ms 输入窗口，100ms warmup；baseline 全矩阵之后才执行 control。固定顺序、低样本量和共享机器意味着这是诊断对照，不是随机化统计实验，也不能把任一比例称为普遍的性能提升。
- 每条输入计时包含整个同步 `onPartial` 回调，作为每 partial 主进程发布预算的保守代理；另记录 snapshot 构造和每次 `webContents.send` 返回耗时。它们不是 CPU 独占时间，`send` 不代表对端已接收。
- IPC 经一个真实生产主世界订阅者，再发小型 ACK；原始 IPC ACK 与 bridge callback 后的 ACK 都用 **main 的同一 `performance.now()`** 算 RTT，包括回程、主进程忙碌和接收队列。两种 RTT 之差不能当作独立 contextBridge 单向耗时。
- 测试窗口隐藏且透明，明确设置 `backgroundThrottling:false`／`disable-renderer-backgrounding`，属于前台式传递实验；无 React、DOM 布局／绘制或屏幕可读延迟测量，不能代表默认后台窗口表现。
- 输入按绝对时间安排。若主进程阻塞到超过 1 秒，剩余输入不再生成，单独记录 requested／logicalInputs、achieved Hz、输入迟到和 ACK 吞吐。**未生成的输入不等于 IPC 丢消息。** 已发送消息必须逐条、按序收到 raw 和 bridge ACK，否则运行失败。
- 原始 54 窗口先 drain partial，再分别发送 empty／final／status／error。它们的 terminal 延迟是清空积压后的诊断，不能证明带积压时的及时性；下节追加四个不先 drain 的窗口。

### 全矩阵

下表全部保留；`B/C` 分别为 baseline／control。时间单位 ms、p95 为 nearest rank；5Hz 窗口只有约 5 个逻辑样本，其 p95 常等于最大值。`sends` 含真实队列计时器产生的额外发布，所以通常为 `2×输入+1`／`输入+1`，不是固定 2／1 次每秒。完整 min／mean／p50／p95／max、throughput、raw ACK、input lateness、terminal 和 payload 代理在 JSON／CSV 中。

| 历史 | 语言 | 请求 Hz | 实际输入 B/C | sends B/C | main partial p95 B/C | bridge RTT p95 B/C | drain B/C |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 1 | 5 | 5/5 | 11/6 | 0.477/0.199 | 2.369/1.429 | 0.831/0.635 |
| 0 | 1 | 20 | 20/20 | 41/21 | 0.144/0.184 | 1.867/0.652 | 0.589/0.381 |
| 0 | 1 | 60 | 60/60 | 121/61 | 0.133/0.157 | 1.098/1.159 | 0.400/0.409 |
| 0 | 3 | 5 | 5/5 | 11/6 | 0.152/0.214 | 0.709/0.848 | 0.565/0.527 |
| 0 | 3 | 20 | 20/20 | 41/21 | 0.108/0.172 | 1.043/2.089 | 0.892/0.476 |
| 0 | 3 | 60 | 60/60 | 121/61 | 0.202/0.185 | 1.049/1.345 | 0.437/0.376 |
| 0 | 8 | 5 | 5/5 | 11/6 | 0.411/0.215 | 1.032/1.488 | 0.470/0.581 |
| 0 | 8 | 20 | 20/20 | 41/21 | 0.168/0.665 | 1.164/69.970 | 0.328/69.467 |
| 0 | 8 | 60 | 60/60 | 121/61 | 0.275/0.581 | 0.943/2.486 | 0.417/2.461 |
| 150 | 1 | 5 | 5/5 | 11/6 | 0.851/1.128 | 3.557/4.440 | 1.743/1.422 |
| 150 | 1 | 20 | 20/20 | 41/21 | 0.786/0.755 | 2.499/2.820 | 2.072/1.762 |
| 150 | 1 | 60 | 60/60 | 121/61 | 1.717/0.883 | 3.297/2.140 | 3.208/1.057 |
| 150 | 3 | 5 | 5/5 | 11/6 | 6.574/1.592 | 13.916/4.491 | 5.237/2.937 |
| 150 | 3 | 20 | 20/20 | 41/21 | 3.542/2.683 | 7.122/5.587 | 4.468/2.915 |
| 150 | 3 | 60 | 60/60 | 121/61 | 3.702/1.837 | 6.137/7.573 | 3.349/2.155 |
| 150 | 8 | 5 | 5/5 | 11/6 | 4.513/2.164 | 9.089/6.153 | 6.509/2.904 |
| 150 | 8 | 20 | 20/20 | 41/21 | 6.982/1.813 | 7.906/5.057 | 5.651/2.319 |
| 150 | 8 | 60 | 60/60 | 121/61 | 4.203/2.216 | 6.549/7.286 | 2.552/2.026 |
| 1150 | 1 | 5 | 5/5 | 11/6 | 8.519/5.099 | 19.250/15.578 | 10.364/8.599 |
| 1150 | 1 | 20 | 20/20 | 41/21 | 16.383/21.365 | 28.901/345.140 | 13.324/7.213 |
| 1150 | 1 | 60 | 58/60 | 117/61 | 24.215/14.908 | 68.166/63.173 | 53.256/6.438 |
| 1150 | 3 | 5 | 5/5 | 11/6 | 18.422/17.946 | 46.199/134.840 | 27.820/25.898 |
| 1150 | 3 | 20 | 20/19 | 41/20 | 11.591/40.809 | 33.883/329.478 | 25.927/66.550 |
| 1150 | 3 | 60 | 57/51 | 115/52 | 27.448/49.528 | 960.605/596.586 | 987.335/429.007 |
| 1150 | 8 | 5 | 5/5 | 11/6 | 23.611/22.305 | 54.624/42.554 | 28.827/20.280 |
| 1150 | 8 | 20 | 20/18 | 41/19 | 21.268/111.736 | 58.048/685.244 | 26.910/443.584 |
| 1150 | 8 | 60 | 36/55 | 73/56 | 46.299/30.737 | 726.132/363.518 | 692.543/360.936 |

参考 150／3／20 的 baseline：20 次输入、41 次发送，main p95 **3.542ms**、bridge RTT **7.122ms**、drain **4.468ms**，在预设参考预算内；control 为 21 次发送、**2.683／5.587／2.915ms**。主进程构造 snapshot 的 p95 仅约 0.002ms，主要同步成本在完整对象传递；这不等于已定位 Electron 内部每一个序列化阶段。

指定压力 1150／8／60：baseline 仅完成 **36 次／34.81Hz**，main p95 **46.299ms**、bridge **726.132ms**、drain **692.543ms**；control 完成 **55 次／54.88Hz**，但 **30.737／363.518／360.936ms** 仍超诊断预算。这说明该合成极限存在积压，不能把 control 称为达成 60Hz，也不能把不同实际输入总数的总字节简单比成减半。

不能只选指定压力行：全矩阵 baseline 在 1150／3／60 的 bridge／drain 达 **960.605／987.335ms**；control 在 1150／8／20 的 main p95 **111.736ms**、bridge **685.244ms**，反而慢于同场景 baseline。baseline 13／27、control 10／27 行至少一项诊断预算超标；这是机器相关观测，性能超预算不使 CI 失败。协议计数、顺序和 terminal 正确性则是硬断言。

baseline 共 **1771** 次 send／raw ACK／bridge ACK，control **1018** 次，全部一致、FIFO、terminal 丢失 0、跨 case 异常 publish 0。此总数含 warmup、终态及清理，不能视为相同工作量下的吞吐比。

### 字节数与吞吐口径

真实生产 snapshot 的 live 内容由实际 CaptionQueue 产生，与“每条都已经有译文”的纯代理 fixture 不同；两份 payload 大小不可混用。以下为实际代表性 snapshot 的输出长度。累计 payload 为一次代表值乘实际 partial sends 的**估计**，不是逐帧 byte-perfect 测量，更不是 Mojo wire／网络流量。

| 场景 | JSON UTF-8 bytes/次 | V8 bytes/次 | partial sends B/C | 估计 JSON 总 bytes B/C | 估计 V8 总 bytes B/C |
| --- | --- | --- | --- | --- | --- |
| 0/1/5 | 1164 | 1112 | 11/6 | 12804/6984 | 12232/6672 |
| 150/3/20 | 508423 | 509424 | 41/21 | 20845343/10676883 | 20886384/10697904 |
| 1150/8/60 | 5746364 | 5818610 | 73/56 | 419484572/321796384 | 424758530/325842160 |

参考 baseline 的实际发送速率 **41.037 sends/s**，窗口内 bridge ACK **41.037/s**；指定压力分别为 **70.594 sends/s** 与 **43.517 ACK/s**（精确未舍入值见 JSON），其差额须在输入结束后 drain。速率的分母是实际观察窗口时长，不能用预期 1 秒掩盖同步阻塞造成的延长。

### 积压中的 terminal

为避免“先清空积压再测 final”的盲区，追加参考／压力各两 variant 共 **4 个窗口**：输入阶段结束后不等待已有 ACK，立即在同一个 main turn 同步调用有效 empty／final／status／error，分别圈定各调用自己的同步 send ordinal 范围，最后统一 drain。旧 utterance 的 empty 仍先验证不发送。每窗口同步范围为 1＋2＋1＋3＝7 次发送；真实 Promise.finally 随后额外 changed 的 1 帧独立计数，不混为某个 terminal 的同步帧。下表为每调用开始到其同步范围最后 bridge ACK 的时长。

| variant | 历史/语言/目标Hz | 实际输入 | terminal 前 pending raw/bridge | empty ms | final ms | status ms | error ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 150/3/20 | 4 | 1/1 | 246.705 | 60.788 | 49.275 | 49.772 |
| baseline | 1150/8/60 | 7 | 5/5 | 1017.123 | 499.298 | 278.057 | 330.766 |
| single-publish-control | 150/3/20 | 20 | 0/0 | 91.742 | 89.463 | 83.659 | 92.169 |
| single-publish-control | 1150/8/60 | 26 | 20/21 | 6554.925 | 6610.532 | 6624.296 | 6396.144 |

两 variant 各 **44／66** 次 send／raw／bridge ACK 全部匹配，terminal 丢失 0，FIFO、清理后不再发布、最终 pending 0 均通过。control 参考窗口开始时 pending 为 0，不能称该行复现了原有积压。

本轮长尾必须保留：baseline 参考只生成 4／20 次输入，empty ACK 246.705ms；control 压力仅生成 26／60，status ACK **6624.296ms**。这轮与共享容器的回归构建存在短暂重叠，没有 CPU 独占或 GC 定位，不能把这些差异全部归因于变体；但同样不能忽略长尾或宣称 terminal 有 100ms 保证。证据支持“在此环境已发送终态可完整观察”，**不支持极限负载下及时性已解决**。原始四窗口、首次54窗口和后续参考重复全部分开保存，不以好看的重复运行替换负面数据。



### 单独参考重复

首次矩阵与积压窗口原样保留后，根代理独立执行参考窗口每 variant 三次；回归构建已结束，仍未声称独占云机器。六窗口均实际生成20次输入，各自收到完整 ACK。

| variant | repeat | main partial p95 ms | bridge RTT p95 ms | drain ms |
| --- | --- | --- | --- | --- |
| baseline | 1 | 2.706 | 4.746 | 2.586 |
| baseline | 2 | 3.219 | 4.942 | 3.765 |
| baseline | 3 | 4.484 | 8.149 | 5.407 |
| single-publish-control | 1 | 1.731 | 3.734 | 1.940 |
| single-publish-control | 2 | 1.479 | 4.526 | 1.942 |
| single-publish-control | 3 | 1.514 | 3.626 | 1.882 |

baseline第三次main p95 **4.484ms**超4ms诊断预算，bridge和drain仍在预算内；不能将首次参考全通过推广为每次必过。参考重复共baseline153／control90次send，各自raw／bridge数量一致、FIFO、terminal零丢失。完整记录在 `reference-repeat/ipc-results.json`。CI也保留这六个有界窗口，性能数值允许随机器变化。

### 本批决定与验收范围

本批交付基准、证据和 CI，**生产 `src/` 保持 C7 不变**。首次参考矩阵没有显示必须改协议的瓶颈，后续重复及共享负载显示参考预算也有长尾；大历史／多译文压力下确有全量传递成本，但单次顺序对照有明显反例，且简单去掉重复发送仍无法稳定满足极端负载预算。没有据此引入合帧、节流、增量状态或 UI 重写。

下一项可执行工作是独立、有界地验证重复 nonempty partial 发布的完全等价性，并以正反顺序、较长稳定窗口重测。如果采用一处去重，仍必须单独覆盖 final／error／status、空 partial、历史查找／焦点、暂停／重启与 PR #4 的组合边界；本报告不代替该优化的验收。

来源为上述精确 LingoBar 源码和 Electron 官方 API 文档。harness／fixture 是项目内原创测试代码，沿用 CC BY-NC 4.0，不复制第三方实现，不引入新依赖。价值是把历史规模、语言数、partial 频率与传递成本关联，避免依据猜测改协议。验收是全部合成窗口可重现、生产源码 hash 可核对、ACK 无丢失／重复／乱序、禁用服务和设备，并保留所有超预算与负面结果。

```sh
npm run benchmark:snapshot:serialization
npm run benchmark:snapshot:ipc
npm run benchmark:snapshot:ipc -- --critical-under-load --output artifacts/snapshot-benchmark/critical
# 选择参考窗口重复最多三次；不重复全矩阵来筛选有利结果
npm run benchmark:snapshot:ipc -- --case reference --repeat 3 --output /tmp/lingobar-snapshot-reference
```

CI 只在原有 Ubuntu UI job 增加此合成测量，Windows／macOS 的测试和构建继续运行；不新建安装包分支、不升级付费计划。artifact 只上传 JSON／CSV／Markdown／LICENSE／NOTICE，不上传临时编译源、profile 或音频。测量基线为 C7，不包含 PR #4；此前组合 C7＋E120 的 303 Vitest＋7 reading、210 UI、25 Electron fake-device 和 54 个 backlog 比较通过，只说明这些回归，**未把组合版本冒称此次 IPC 测量或实机验证**。

Mac 离线验收与组合边界见 [macos-offline-validation.md](macos-offline-validation.md)；云端本批未操作用户 Mac。
