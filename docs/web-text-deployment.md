# 网页文字翻译：最短部署步骤

这一批让手机和电脑网页主动粘贴文字后翻译，复用原文、所选1–8种语言、日语注音、
历史及收藏。它只调用 DeepSeek，不打开麦克风或 ASR；并非已经部署或实机验收。

原PR14/17只有音频会话及独立注音接口，缺少网页文本输入与`/api/translate`；
`WEB_ENABLED=1`还强制要求ASR密钥。新代码补齐这三处，音频保持关闭。

## 配置与启动

正式gateway可通过`TRANSLATION_API_KEY_FILE`直接读取既有私有JSON中的`apiKey`，
也兼容原来的环境变量`TRANSLATION_API_KEY`；显式文件路径优先。固定调用
`https://api.deepseek.com/chat/completions`的`deepseek-flash`，禁用思考与工具。
配置`TRANSLATION_API_KEY_FILE=/var/lib/lingobar-text-test/credentials/deepseek.json`即可
衔接用户已填写的同一文件，无需再输入或复制密钥；文件须为可读的私有普通JSON。
它不自动搜索密钥，也不读取Electron或浏览器密钥。
不要把密钥放进命令参数、聊天、静态前端或Git。无需PR18传输工具。

环境文件只需以下配置；Access三项沿用当前已有应用的值：

```dotenv
WEB_ENABLED=0
WEB_TEXT_ENABLED=1
GATEWAY_PORT=8788
GATEWAY_PUBLIC_ORIGIN=https://lingobar.mayoneko.top
ACCESS_ISSUER=https://<现有团队>.cloudflareaccess.com
ACCESS_AUDIENCE=<现有应用的64位aud>
ACCESS_ALLOWED_EMAIL=<现有允许邮箱>
GATEWAY_TEXT_LEDGER_DIRECTORY=<原PR17累计预算账本目录>
TRANSLATION_API_KEY_FILE=/var/lib/lingobar-text-test/credentials/deepseek.json
```

账本目录不是`credentials/`目录，必须填写之前持有`test-budget.json`的**同一个**
持久目录；不能另建1元预算、清零或按日期重置。新构建包含更新后的执行器，旧二进制
不能解析新增web预留记录时会拒绝，不能为兼容而删账本。网关运行期间持有原有账本锁，
不要同时运行旧one-shot CLI。这里只新增原账本中的固定web预留槽位，没有新数据库。

使用已有Node22，在安装后的gateway目录运行（环境文件路径示例，按部署线程实际路径替换）：

```sh
node --env-file=/etc/lingobar-gateway/gateway.env gateway.cjs
```

若由现有服务管理器启动，可沿用它的私有EnvironmentFile和重启方式；本云任务不改
VM服务或开机启动规则。Node的`--env-file`只在命令行包含路径，不包含密钥值。
不要同时设置`WEB_ENABLED=1`：当前1元约束尚不能覆盖ASR，混合启用会被拒绝。

## 同源接线

同时替换本批静态前端与gateway构建，保留现有Access/Tunnel。代理继续指向
`127.0.0.1:8788`，透传原公共Host、Origin和`Cf-Access-Jwt-Assertion`：

- `GET /app-config.json`必须交给gateway，覆盖旧静态`backend:null`文件。
  文本模式返回`{version:1,backend:null,textBackend:"/api/translate"}`；不返回密钥。
- `POST /api/translate`新增文本翻译路径，必须送到gateway。
- `POST /api/annotation`保留日语独立补注音，同样走累计预算。
- `/healthz`仅本机检查。`/api/session`保持拒绝，不能因此启用录音。

新网页显示“文字翻译”，由用户自己粘贴并显式提交；结果进入现有字幕/历史。
没有后台剪贴板、额外窗口或新的登录体系。旧静态前端会拒绝新增配置字段，因此
不能只升级服务器，必须与本批前端配套。

## 本轮总额1元

沿用批次`lingobar-test-2026-10-28`的同一累计账本，旧translation/ruby预留保留。
每次**实际供应商请求**先按“完整输入token上界×2微元＋输出硬上限×8微元”
持久预留，直接使用整数计算，不额外取整为0.1元。失败、取消和重启不退款，也不
跨日重置。预留是本地预算占用，不是声称供应商已经扣了这笔钱。
新web最多20个预留槽，通常先触及1元总额；旧两步的0.04元预留也继续占用。
一次用户提交可能包含翻译及日语注音，注音格式重试也逐次计入，不称一次点击一个请求。
用尽后拒绝请求；本期不是无限持续服务额度。

使用原有已核对的纯文本编码上界：完整system/user的UTF8字节数，加JSON格式指令
105字节及5个控制token，不超过8192；它来自所记录1017 tokenizer/recipe的非扩张
ByteLevel/BPE规则，**不是平均字符估算**，也没有调用供应商去数token。
只允许两条纯字符串消息、固定DeepSeek地址/模型、非流式、思考关闭、无工具/图片/
历史，输出上限8192。2026-10-29官方CNY高峰未缓存输入2元/百万token、输出8元/
百万token时，每次条件上界`8192×2+8192×8=81920微元=0.08192元`，服务按本次实际完整输入上界计算预留，最多0.08192元，无额外安全余量。
原句最多2000 UTF8字节，过长请用户自行缩短，不静默截断。

这沿用已有编码机制用于有界纯文本，**不是旧两个固定request hash证明自动批准任意
输入**。实现仍在出站前检查完整请求形状和字节上界。前提是账户按已核CNY目录结算、
官方API遵守公布编码/输出契约及费率；不是实际账单保证，也不覆盖绕过此服务的其他调用。
赠额不作为上限依据。上线后的真实调用仍须由部署任务在同一1元预算内执行。

价格来源：[DeepSeek官方人民币表](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。
编码来源和哈希沿用仓库[evidence/text-test-proof.json](../evidence/text-test-proof.json)；
其中旧固定请求的日期/执行开关不被本服务当成启用指令，也不改写该证明。

## 本批验证与剩余工作

云端只做必要的配置/HTTP/账本/浏览器会话mock测试、typecheck及构建；不调用真实API、
不读取密钥，不访问用户Mac或VM，也不重复全套平台验收。部署线程完成环境文件、
服务重启和同源路由后，先看动态配置与文字入口，再用极短文本显式验收。
这不代表麦克风、手机Safari、供应商质量/费用或ASR已经通过实机验证。
