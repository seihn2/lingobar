# 一元累计预算：固定文本单次测试

本执行器只接受两个独立的合成文本步骤：`translation` 或 `ruby`。每步最多一次，
不监听端口，不接浏览器输入、不录音，也不自动串联下一步。ASR 始终拒绝。普通 Web
网关保持关闭；它的每日请求数限制不等于人民币上限。

**本产物默认禁止真实执行。** 构建、测试和校验均不读取服务密钥，不调用供应商。
`WEB_ENABLED=1` 不能打开此执行器。离线证明、价格/账户条件、唯一持久账本和受控
凭据入口必须全部符合准入契约，才有资格安排受限真实调用；打包成功不代表已经启用。

## 已确认事实与本轮未执行事项

以下账户和部署信息由父任务核验后转交，本文作者没有访问账户或 VM：

- PR14 禁用态网关已部署到既有 VM 的 Node22、`127.0.0.1:8788`；这不表示真实
  ASR/翻译已启用，也不是本次执行器已安装验证。
- DeepSeek 账户按人民币结算，资金足够计划中的两次预留。持续配置已有密钥已获
  用户授权，但密钥尚未迁移；本云端没有读取、显示、解密或迁移密钥。
- ASR 被报告有565.46K免费 token、到期日2026-12-21。用户明确拒绝启用“用完即停”，
  本实现不修改该设置。赠额不能证明未知计费上界，ASR 不参与本执行器。

本轮预算是**所有供应商合计最多人民币1元**，不是每天1元，也不是每供应商1元。
当前这批代码开发与验证的实际收费请求为0；没有用收费请求探测 usage 或余额。

## 两个固定请求

沿用 `textRequest()` 的原样 JSON 请求，固定
`https://api.deepseek.com/chat/completions`、`deepseek-flash`、
`stream:false`、`max_tokens:128`、`thinking:{type:'disabled'}`、
`tool_choice:'none'`、`response_format:{type:'json_object'}`。
无工具、搜索、抓取、文件、图片、音频、多候选或历史消息。请求 SHA256 逐字节绑定
离线证明；不能传入任意 prompt、模型、URL、输出上限、重试编号或自报 token 数。

| 步骤 | 固定合成内容 | 完整本地编码 token 上界 | 条件最高计价 | 持久预留 |
| --- | --- | ---: | ---: | ---: |
| translation | `Hello.` 翻译为日语 | ≤225 | ≤0.001474元 | 0.02元 |
| ruby | 为固定「学校」槽填假名 | ≤325 | ≤0.001674元 | 0.02元 |
| ASR | 无请求 | 未证明 | 拒绝报价 | 拒绝预留 |

价格采用2026-10-28官方人民币目录的**高峰、全部缓存未命中**上界：输入2元／百万
 token、输出8元／百万 token。即225×2＋128×8＝1474微元；325×2＋128×8＝1674微元。
两次条件合计3148微元（0.003148元），仍各预留20000微元，总预留0.04元。
剩余0.96元不授权更多步骤或重试。价格证明须在执行时仍有效，不能靠缓存命中、
空闲时段、赠额、其他币种换算或未知合同放宽。

[官方人民币价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)、
[官方请求参数](https://api-docs.deepseek.com/api/create-chat-completion/)。
这些是有前提的计算，不是实际账单，也不保证供应商违反已公开契约时客户端仍可
控制其计费。超时与响应字节限制是本地资源保护，不是供应商停止计费的证明。

## 完整输入证明的范围

证明记录在 [`evidence/text-test-proof.json`](../evidence/text-test-proof.json)，
校验模块是 [`scripts/text-test-proof.cjs`](../scripts/text-test-proof.cjs)。
它绑定固定请求、官方 recipe commit、模板/词表适用性和工程上界；
`executionAllowed:false` 保留在随包证明中，不把构建工具运行成功当成执行授权。

225/325是针对固定纯文本路径的**算法上界**，不是实际 BPE token 数，也不是
任意模型的“一个字节一个 token”估算。证明链包括：空 normalizer、只分割的
pretokenizer、无额外前缀的 ByteLevel、只合并的 BPE、无 padding、禁自动追加
special tokens，再显式计入 BOS/System/User/Assistant/ThinkingEnd 共5个控制 token。
JSON object 格式向 system 追加的105个 UTF8 字节也包含在内：
translation 为196＋24＋5，ruby 为238＋82＋5。任何模板、配置或请求变化须重新审阅，
不能用等长请求或随意注册 model alias 代替匹配。

本轮已对官方1017文件与recipe词表作纯文本适用性对照：两个原始文件的整体SHA256
不同，差异限于一个图像added-token的内容和special标记；所用普通编码配置、
BPE词表/merges及五个显式控制token一致。证明仅覆盖这两个无图像固定请求，不将
整体文件声称逐字节相同，也不推广到任意输入或媒体。实际hash和版本保存在证明中。

[官方 recipe（MIT）](https://github.com/deepseek-ai/deepseek-recipe)、
[固定版本模板](https://github.com/deepseek-ai/deepseek-recipe/blob/935817c66f5d6e64838f419692545f06787e485f/deepseek-recipe-encoding/src/v4/dsv41.rs)、
[JSON 序列化](https://github.com/deepseek-ai/deepseek-recipe/blob/935817c66f5d6e64838f419692545f06787e485f/deepseek-recipe-core/src/json.rs)、
[1017模型卡](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017/blob/main/README.md)、
[官方部署说明](https://github.com/deepseek-ai/DeepInfer/blob/main/doc/inference_deployment_qa.md)、
[ByteLevel实现](https://github.com/huggingface/tokenizers/blob/v0.23.2/tokenizers/src/pre_tokenizers/byte_level.rs)、
[BPE实现](https://github.com/huggingface/tokenizers/blob/v0.23.2/tokenizers/src/models/bpe/model.rs)。

仅独立参考这些机制，没有安装或执行 recipe/tokenizer，没有复制上游实现或将大型
词表作为 VM 运行时依赖。tokenizer 的独立许可及固定组件适用性记录属于证明审阅，
不能只凭 README、模型别名或字符比例宣布线上计费已验证。官方自身也将
[字符/token比例](https://api-docs.deepseek.com/quick_start/token_usage/)称为近似。

## 单一账本与发送顺序

固定 batch 为 `lingobar-test-2026-10-28`，总上限1000000微元。没有日期重置、退款、
补充额度或任意 attempt ID。所有同轮供应商测试必须共用同一份账本；未知或尚未
核清的其他支出会阻止准入，不能假定为0。已有旧 ASR 预留不能清除或改成零。

1. 校验固定请求与证明、价格/账户条件、同轮其他支出及安装配置。
2. 获取覆盖整个进程调用周期的跨进程独占锁，打开**已存在**的唯一私有账本。
3. 对该固定 step 持久预留20000微元，完成写入、fsync、rename和目录fsync后，
   才可读取受控凭据并进行一次固定 POST。
4. 处理有界响应，持久记录脱敏结果分类；成功、HTTP错误、取消、超时、截断或
   格式失败都保留原预留，不自动重试、不自动调用另一步。

持久预留即按“可能已发送”处理。即使在预留后、fetch前崩溃，该 step 也已耗用，
不得重放或退款。响应 usage 缺失不能补救请求前缺失的证明；异常或超计划 usage
触发后续封锁。输出丢失也不是再次执行的许可。

账本目录0700、文件0600，使用单一服务用户。schema/批次/币种/金额/求和/字段
严格校验；缺失、损坏、高版本、符号链接、不安全权限、残留 lock/pending 均拒绝。
不自动初始化或抢占锁；只有操作员显式调用一次性初始化才可新建。写入任何阶段
失败后，本进程拒绝后续调用；rename成功但目录fsync失败仍不发送/退款。

账本不保存原文、密钥、JWT或供应商原始响应，仅有限步骤、哈希、预留金额、时间
和脱敏状态。运维不能删除账本、换目录、换容器或改日期恢复次数。崩溃恢复须先
确认原进程退出并保留已预留金额；此工具不提供自动删锁或自动重置入口。

## 安装与后续启用边界

安全构建包保留以下结构，均列入 `GATEWAY-MANIFEST.json` 和 SHA256 清单：

```text
gateway.cjs                         # 仍为禁用态普通网关
scripts/run-one-rmb-text-test.cjs     # 独立 CLI
scripts/plan-one-rmb-test.cjs         # 固定构造器和累计账本
scripts/text-test-proof.cjs          # 固定证据校验
scripts/text-test-installation.json  # 默认关闭，路径均为null
evidence/text-test-proof.json        # 随包离线证明
```

操作员先核对精确 source SHA、全包摘要和证明阻塞项；由父任务指定**唯一持久账本
目录**及受控凭据文件路径，配置安全接入并核清同轮支出。不能从浏览器参数、日期、
供应商名、`WEB_ENABLED` 或任意命令行参数选择账本/服务地址。当前配置没有可用
密钥或账本路径，默认命令必须在任何读取凭据/联网前拒绝：

```sh
node scripts/run-one-rmb-text-test.cjs translation
node scripts/run-one-rmb-text-test.cjs ruby
```

每个命令须由用户/授权流程单独明确执行。翻译成功不自动启动注音。返回只包含
脱敏状态与本地调用计数；默认拒绝exit2，保留预留的失败exit1，成功exit0。
没有HTTP管理接口，也没有把一元预算推广为普通网关的持续人民币硬停。

尚未完成本执行器的VM安装核验、唯一账本/凭据安全接线和真实两次请求。账户CNY
及持续密钥配置授权已有父任务证据，不再将其写成未授权或要求用户重发密钥。
手机麦克风、Access/Tunnel全链路、供应商质量/延迟和实际账单仍需分别验收。

## 免费验证

```sh
npm run typecheck
npm run test:gateway
npm run plan:test-budget
npm run build:web && npm run verify:web
npm run build:gateway && npm run verify:gateway
```

本地使用已安装的Node24；CI使用Node22，分别记录实际版本/命令和结果。
验证仅使用合成文件、mock transport和受控loopback：准入失败0请求、每step最多1次、
取消/错误/崩溃不退款、跨进程锁、原子写故障、证明变更拒绝、异常usage封锁，以及
默认打包CLI在`WEB_ENABLED=1`时仍拒绝且0网络尝试。它们不等于真实供应商计费、
VM执行器安装、手机实机或服务质量验证。项目保持CC BY-NC4.0，不合并、发布或部署。
