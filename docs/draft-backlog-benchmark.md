# 等待中 partial 快照刷新：离线合成对照

本轮不建议把下面两个实验直接应用到生产调度器。“仅快照刷新、保留现有计时器”会在部分场景重复请求同一 revision；合并等待计时器能消除本组中的这类重复，但仍会推迟首份可读内容、部分最终译文，以及切换目标语言后的可读结果。它们也确实在若干积压场景更快追上最新原文。因此，结论只针对这两个明确实验，不代表所有队列刷新策略都无效。

本提交只提供基准脚本、合成 fixture 和报告，不改应用 `src/`。暂停收尾的 PR #4 是独立工作；本基准没有引入或测量它的 `finish()`、超时提示或平台改动，也不产生新的功能安装包。

## 精确基线与重现

- 基线：PR #3 的精确提交 [`2a42a485ec177f320823773afdd2bf13b03770f1`](https://github.com/seihn2/lingobar/commit/2a42a485ec177f320823773afdd2bf13b03770f1)。
- `src/main/captions.ts` 的 Git blob：`14670011a77d7f39ad4ffc6c5f2b8968901bc4f2`。
- 原始源码 SHA-256：`12583eb153b9f9d5bd06821a07bfc5902593e3c0a9451c53edf86db331838b64`，运行前后不变。
- 本地环境：Linux x64、Node.js `v24.19.0`、Vitest `3.2.6`、esbuild `0.25.9`。测量使用 Vitest 假时钟，不是 Linux、Windows 或 Mac 实际收音／网络耗时。

```sh
# 浅 clone 缺少基线对象时，先取精确提交；这是仓库元数据获取，不是服务测试。
git fetch --no-tags --depth=1 origin 2a42a485ec177f320823773afdd2bf13b03770f1
npm ci
npm run benchmark:captions
```

[驱动](../scripts/benchmark-captions.cjs)用 `git show` 读取该提交的真实 CaptionQueue 和所有运行时源码依赖，不依赖工作区中新旧 `src/` 的内容。现有 esbuild 将它们构建到被忽略的 `artifacts/caption-benchmark/`；仓库内只保存[明确的小插入补丁](../test/benchmarks/experiments.cjs)，没有复制另一份生产调度器。原有诊断函数替换为两组共用的内存观察器，不读 Electron 配置或日志。

无需新增依赖。驱动本身离线运行，模拟服务由构造参数注入；`fetch` 被替换为计数后抛错的护栏，并逐次断言 **0 次 provider 调用**。未读取录音、麦克风、真实字幕、服务账户或密钥。

输出包括：

- `artifacts/caption-benchmark/manifest.json`：基线 ref、原始及实验源码 hash、插入补丁 hash、依赖源码 hash、工具版本。
- `artifacts/caption-benchmark/results.json`：54 次运行的完整请求／发布轨迹、时序、取消和字段保持断言结果。
- `artifacts/caption-benchmark/results.csv`：完整数值表，含全部请求数和最终空闲状态。
- `artifacts/caption-benchmark/tables.md`：下面两张对照表的可重现来源。

## 三个策略

以下各表的数值顺序统一为 **B / S / M**。

| 标记 | 策略 | 唯一改动 |
| --- | --- | --- |
| B | 精确基线 | 运行原始 CaptionQueue。 |
| S | 仅快照刷新、保留现有计时器 | 更新原文时，如果同一 caption 已有等待中的 partial，只刷新该任务的 `original` 和 `revision`；原有 `scheduleDraft` 继续执行。 |
| M | 快照刷新并合并等待计时器 | 在 S 的同一位置刷新等待任务后，清除已被该任务涵盖的 draft timer，并跳过本次另开 timer。仅这一个附加策略。 |

S/M 都保持等待任务的 `config` 对象、队列位置、`queuedAt`，不修改运行中任务或 final 的快照、队列公平规则、2 个翻译槽、650ms 首次合并或 1100ms 后续间隔。没有为实验调节阈值。基准对运行中和其他等待任务的字段保持也作断言。

## 模型与场景

模拟识别更新由 fixture 定时送入；这不是 ASR 延迟测试。单次模拟翻译同时返回请求中选定的全部语言。

| 服务模型 | 精确规则 |
| --- | --- |
| `fixed` | 普通请求固定 300ms；100 partial／8 targets 场景固定 1500ms。两个 blocker 按 fixture 指定时间释放。 |
| `length-sensitive` | `180 + 4 × source UTF-16 code units + 15 × 目标语言数量` ms；blocker 仍按指定时间释放。这个公式只是明确的假设，不拟合真实模型。 |

| 场景 ID | 时间线（绝对假时钟 ms） |
| --- | --- |
| `no-backlog` | 无 blocker；partial 在 0／700，到 6000 给 final。负对照要求 B/S/M 完整结果相同。 |
| `blocked-750` | 两槽占满到 750；partial 在 0／700；650 时首个 partial 已入等待队列；final 在 6000。 |
| `blocked-1200` | 与上项相同，blocker 到 1200。 |
| `final-during-service` | 两槽占满到 1200，partial 在 0／700；final 在 1400 到达，首个 draft 仍在运行。 |
| `100-partials-8-targets` | 0～1980 每 20ms 一次累积更新，共 100 次、8 个目标语言；blocker 到 2500；final 在 12000。 |
| `final-fairness` | blocker 到 1000；另有一条等待 draft；700 时加入 history/final，检查它在 1000 的首批空槽获调度。 |
| `configuration-snapshot` | blocker 到 1200；675 时仅把目标从 `en` 改为 `fr`，供应商与模型不变；700 时更新 partial；final 在 6000。 |
| `cancel-cooperative` | blocker 到 750；800 时 `close()`，模拟服务遵守 AbortSignal。 |
| `cancel-late-result` | 同上，但模拟服务故意不理会 AbortSignal，有限时长后才返回；检查关闭后不发布晚结果。 |

两个普通 partial 的原文分别为 26／314 个 UTF-16 code units、26／578 个 UTF-8 bytes。合成文字含 CJK、补充平面汉字和重音字符，避免把字符串长度误当 UTF-8 字节数。所有原文都短于生产的 6000-unit 分段阈值；本轮不测超长分段、注音服务、网络抖动、限流、真实模型准确率或计费。

## 指标口径

- **First any**：目标 caption 首次有至少一种**当前所选语言**的可读译文，可能仍落后于当前识别文本，也可能第一份就是 final。已隐藏的旧目标语言不算可读。另在 JSON/CSV 保留 `firstPublishedAnyLanguageMs`，区分“发布了旧语种”与“当前用户有译文可读”。
- **First fresh**：首次有当前所选语言可读，且 `translatedOriginal` 等于当时最新已听原文。100 次更新场景另报 **Last-partial fresh**，避免早期追上一次被误当为追上最后一版。
- **Final**：对应最终原文的译文首次发布。所有时间从 fixture 的 `t=0` 起算，单位 ms；不是相对改善百分比或真实服务性能。
- **Draft requests** 只计目标 live caption 的 `partial=true` 请求；**Live requests** 同时包括它的 draft 与 final。blocker、辅助 draft、history 不计入这两个数，但完整 CSV 的 `allRequests` 会计入。
- **Source UTF-16 / UTF-8 bytes** 是该目标 caption 所有已提交模拟请求的原文长度之和，包含后来取消的请求；每次请求只计一次原文，不乘目标语言数。它们**不是实际 tokens，也不能换算 API 费用**。未测模型 tokenizer、提示词、输出或服务商取消计费规则。
- **Duplicate revision requests** 计同一目标 caption、同一 revision 与 partial 标记再次提交的次数。
- **Max active** 是模拟服务同时未完成的请求数，**Max waiting** 是真实队列的等待任务数；二者均包含 blocker／辅助／history。
- **—** 表示没有取得该结果，例如取消后未发布译文，或直接由 final 完成而没有先发布最后一版 partial。

## 精确对照表

| Model | Scenario | Draft requests B / S / M | First any ms B / S / M | First fresh ms B / S / M | Last-partial fresh ms B / S / M | Final ms B / S / M |
| --- | --- | --- | --- | --- | --- | --- |
| fixed | no-backlog | 2 / 2 / 2 | 950 / 950 / 950 | 2050 / 2050 / 2050 | 2050 / 2050 / 2050 | 6300 / 6300 / 6300 |
| fixed | blocked-750 | 2 / 2 / 1 | 1050 / 1050 / 1050 | 1650 / 1050 / 1050 | 1650 / 1050 / 1050 | 6300 / 6300 / 6300 |
| fixed | blocked-1200 | 2 / 1 / 1 | 1500 / 1500 / 1500 | 1800 / 1500 / 1500 | 1800 / 1500 / 1500 | 6300 / 6300 / 6300 |
| fixed | final-during-service | 1 / 1 / 1 | 1500 / 1500 / 1500 | 1800 / 1800 / 1800 | — / 1500 / 1500 | 1800 / 1800 / 1800 |
| fixed | 100-partials-8-targets | 2 / 1 / 1 | 4000 / 4000 / 4000 | 5500 / 4000 / 4000 | 5500 / 4000 / 4000 | 13500 / 13500 / 13500 |
| fixed | final-fairness | 2 / 2 / 1 | 1300 / 1300 / 1300 | 1650 / 1300 / 1300 | 1650 / 1300 / 1300 | 6300 / 6300 / 6300 |
| fixed | configuration-snapshot | 2 / 1 / 1 | 1800 / 6300 / 6300 | 1800 / 6300 / 6300 | 1800 / — / — | 6300 / 6300 / 6300 |
| fixed | cancel-cooperative | 1 / 1 / 1 | — / — / — | — / — / — | — / — / — | — / — / — |
| fixed | cancel-late-result | 1 / 1 / 1 | — / — / — | — / — / — | — / — / — | — / — / — |
| length-sensitive | no-backlog | 2 / 2 / 2 | 949 / 949 / 949 | 3201 / 3201 / 3201 | 3201 / 3201 / 3201 | 7455 / 7455 / 7455 |
| length-sensitive | blocked-750 | 2 / 1 / 1 | 1049 / 2201 / 2201 | 2801 / 2201 / 2201 | 2801 / 2201 / 2201 | 7455 / 7455 / 7455 |
| length-sensitive | blocked-1200 | 2 / 1 / 1 | 1499 / 2651 / 2651 | 2950 / 2651 / 2651 | 2950 / 2651 / 2651 | 7455 / 7455 / 7455 |
| length-sensitive | final-during-service | 1 / 1 / 1 | 1499 / 2651 / 2651 | 2954 / 4106 / 4106 | — / 2651 / 2651 | 2954 / 4106 / 4106 |
| length-sensitive | 100-partials-8-targets | 2 / 1 / 1 | 6804 / 6844 / 6844 | 11148 / 6844 / 6844 | 11148 / 6844 / 6844 | 16348 / 16348 / 16348 |
| length-sensitive | final-fairness | 2 / 1 / 1 | 1299 / 2451 / 2451 | 2801 / 2451 / 2451 | 2801 / 2451 / 2451 | 7455 / 7455 / 7455 |
| length-sensitive | configuration-snapshot | 2 / 1 / 1 | 2950 / 7455 / 7455 | 2950 / 7455 / 7455 | 2950 / — / — | 7455 / 7455 / 7455 |
| length-sensitive | cancel-cooperative | 1 / 1 / 1 | — / — / — | — / — / — | — / — / — | — / — / — |
| length-sensitive | cancel-late-result | 1 / 1 / 1 | — / — / — | — / — / — | — / — / — | — / — / — |

| Model | Scenario | Live requests B / S / M | Source UTF-16 B / S / M | Source UTF-8 bytes B / S / M | Duplicate revision requests B / S / M | Max active B / S / M | Max waiting B / S / M |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fixed | no-backlog | 3 / 3 / 3 | 655 / 655 / 655 | 1183 / 1183 / 1183 | 0 / 0 / 0 | 1 / 1 / 1 | 1 / 1 / 1 |
| fixed | blocked-750 | 3 / 3 / 2 | 655 / 943 / 629 | 1183 / 1735 / 1157 | 0 / 1 / 0 | 2 / 2 / 2 | 1 / 1 / 1 |
| fixed | blocked-1200 | 3 / 2 / 2 | 655 / 629 / 629 | 1183 / 1157 / 1157 | 0 / 0 / 0 | 2 / 2 / 2 | 1 / 1 / 1 |
| fixed | final-during-service | 2 / 2 / 2 | 341 / 629 / 629 | 605 / 1157 / 1157 | 0 / 0 / 0 | 2 / 2 / 2 | 1 / 1 / 1 |
| fixed | 100-partials-8-targets | 3 / 2 / 2 | 3024 / 2023 / 2023 | 5117 / 3423 / 3423 | 0 / 0 / 0 | 2 / 2 / 2 | 1 / 1 / 1 |
| fixed | final-fairness | 3 / 3 / 2 | 655 / 943 / 629 | 1183 / 1735 / 1157 | 0 / 1 / 0 | 2 / 2 / 2 | 3 / 3 / 3 |
| fixed | configuration-snapshot | 3 / 2 / 2 | 655 / 629 / 629 | 1183 / 1157 / 1157 | 0 / 0 / 0 | 2 / 2 / 2 | 1 / 1 / 1 |
| fixed | cancel-cooperative | 1 / 1 / 1 | 26 / 314 / 314 | 26 / 578 / 578 | 0 / 0 / 0 | 2 / 2 / 2 | 1 / 1 / 1 |
| fixed | cancel-late-result | 1 / 1 / 1 | 26 / 314 / 314 | 26 / 578 / 578 | 0 / 0 / 0 | 2 / 2 / 2 | 1 / 1 / 1 |
| length-sensitive | no-backlog | 3 / 3 / 3 | 655 / 655 / 655 | 1183 / 1183 / 1183 | 0 / 0 / 0 | 1 / 1 / 1 | 1 / 1 / 1 |
| length-sensitive | blocked-750 | 3 / 2 / 2 | 655 / 629 / 629 | 1183 / 1157 / 1157 | 0 / 0 / 0 | 2 / 2 / 2 | 1 / 1 / 1 |
| length-sensitive | blocked-1200 | 3 / 2 / 2 | 655 / 629 / 629 | 1183 / 1157 / 1157 | 0 / 0 / 0 | 2 / 2 / 2 | 1 / 1 / 1 |
| length-sensitive | final-during-service | 2 / 2 / 2 | 341 / 629 / 629 | 605 / 1157 / 1157 | 0 / 0 / 0 | 2 / 2 / 2 | 1 / 1 / 1 |
| length-sensitive | 100-partials-8-targets | 3 / 2 / 2 | 3024 / 2023 / 2023 | 5117 / 3423 / 3423 | 0 / 0 / 0 | 2 / 2 / 2 | 1 / 1 / 1 |
| length-sensitive | final-fairness | 3 / 2 / 2 | 655 / 629 / 629 | 1183 / 1157 / 1157 | 0 / 0 / 0 | 2 / 2 / 2 | 3 / 3 / 3 |
| length-sensitive | configuration-snapshot | 3 / 2 / 2 | 655 / 629 / 629 | 1183 / 1157 / 1157 | 0 / 0 / 0 | 2 / 2 / 2 | 1 / 1 / 1 |
| length-sensitive | cancel-cooperative | 1 / 1 / 1 | 26 / 314 / 314 | 26 / 578 / 578 | 0 / 0 / 0 | 2 / 2 / 2 | 1 / 1 / 1 |
| length-sensitive | cancel-late-result | 1 / 1 / 1 | 26 / 314 / 314 | 26 / 578 / 578 | 0 / 0 / 0 | 2 / 2 / 2 | 1 / 1 / 1 |

## 观察与取舍

1. **无积压负对照完全相同。** 两种服务模型下，B/S/M 的请求、输入量、发布时序和清理结果均一致。实验影响来自已存在的等待 partial，不是普遍加快翻译。
2. **S 存在同 revision 重复请求。** 固定 300ms、750ms 解堵时，S 在 1050 已追上最新，但原有 timer 到 1350 再次请求同 revision。live 请求数仍为 3，累计输入从 B 的 1183 变为 1735 UTF-8 bytes；M 则为 2 次、1157 bytes。最终译文仍都是 6300ms。这说明合并 timer 的效果不能归功于只刷新快照。
3. **更新快照可能延后第一份可读内容。** 长度敏感的 750ms 场景，B 的 first any 为 1049ms，S/M 为 2201ms，晚 1152ms；但追新从 2801 提前到 2201ms。100 partial／8 targets 中，first any 也从 6804 变为 6844ms，虽然追上最后 partial 从 11148 提前到 6844ms。较新较长的快照不能同时保证更早看到任意前缀。
4. **运行中 draft 也会影响随后 final。** final 在 1400 到达时，长度敏感模型中 B 的 final 为 2954ms，S/M 为 4106ms，晚 1152ms。每组仍都是 2 次 live 请求；S/M 累计原文输入从 605 增为 1157 UTF-8 bytes。这里没有改变 final 的优先规则，而是较长的有用前缀仍占用同一 caption 的运行任务。
5. **保留旧 config 还会影响当前目标语言。** 675ms 从 en 改 fr 后，S/M 把新 revision 写进旧 en 任务；后续 enqueue 会因相同 revision 已存在而跳过，直到 final 才得到 fr。固定模型的当前目标 first any 从 B 的 1800 退到 6300ms；长度敏感模型从 2950 退到 7455ms。旧 en 早已发布不等于当前选中的 fr 可读；因此不能只比较任意已发布语言。等待 config 确实未被改动，但这两个补丁仍不满足完整的语言切换体验。
6. **提前取消时也可能提交更多无可读回报的输入。** 800ms 取消场景中，各组都是 1 个 live 请求且没有可读结果；B 只提交 26 bytes，S/M 已提交 578 bytes。模拟不推断服务商是否收费。

本组里，M 能消除 S 的冗余 timer 请求，但不能消除更长首快照、后续 final 或目标语言变更的代价。建议保持当前生产策略，先保留基准证据；如后续继续探索，应明确优先保证哪一种可读延迟与目标语言语义，再比较新策略。不能从这两个补丁外推“所有等待队列刷新都没有价值”，也不能仅凭模拟中的请求减少宣称真实服务更快或更便宜。

## 正确性与清理

54 次运行全部通过；18 个场景／模型比较测试，每个执行 B/S/M。包括 444 次等待任务快照检查。所有请求结果都通过原文／译文对应断言；无 source 错配。

- 每组最大模拟 active、逻辑 running 均不超过 2，waiting 不超过 3；本组没有验证 20 项等待上限的极限吞吐。
- 两种服务模型、三种策略的 history/final 均在 1000ms 获调度；未发现这组 fixture 下的 final/history 饥饿。这不代表所有负载下的延迟保证。
- 每次运行结束时 active／waiting／running／timer 都为 0；provider 调用计数全部为 0。
- 合作取消在 `close()` 返回时已经停止模拟请求、清空等待和 timer；Promise 的 `finally` 微任务随后移除最后一项 running，不是同步移除。
- 故意不合作的模拟服务在 close 后仍有一项模拟响应 timer，直到有限响应时间到达；它不能再发布 UI 更新，结束后资源计数全部为 0。这里检查的是晚结果隔离，不声称远端模型已经停止计算。

报告数值是确定性的假时钟模型结果，无统计置信区间，也不是 Windows 实机验收。固定基线、模型公式、fixture、全部请求 hash 和发布时序保留在生成结果中，便于反驳或重现本报告。
