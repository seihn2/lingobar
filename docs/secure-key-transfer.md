# DeepSeek 密钥的受控手动配置工具

本批提供一个可审阅的备用入口：用户在本机终端亲自无回显输入已有 DeepSeek
密钥，经固定 SSH 目标的 stdin 送到专用接收器。它不读取 LingoBar 本地资料、
不解密 safeStorage、不调用模型、不更改网络或 SSH 授权，也不启用普通网关。
已有持续配置授权不等于本云端已执行迁移；本次开发与测试实际密钥访问为0。

## 为什么采用这个入口

现有 `src/main/storage.ts` 的 `Storage.key()` 在 Electron 主进程、原系统账户
中调用 safeStorage；preload 没有通用解密/导出接口。0.1.5 也没有可用的 stdin
导出协议。为临时传输开放任意解密 IPC，或复制用户配置到另一上下文，都会扩大
密钥暴露面。本批采用交接明确允许的手动入口，不要求用户把密钥重新发到聊天。
它不能自动取出只保存在旧应用里的密钥；应用内自动传输尚未实现。

## 包含的内容与默认状态

- `send.py`：仅允许无参数启动，读取同目录固定发送配置；配置默认关闭。
- `receive.py`：仅允许 `--probe`、`--receive`；接收器仅针对 Linux。
- 两个 `key-transfer-*.json`：默认关闭，SSH 目标、公钥、身份文件和接收路径为空。
  发送配置现为version2；旧version1拒绝，不默默沿用默认身份或run-as方式。
- `MANIFEST.json`、`SHA256SUMS.txt`：源提交、文件摘要、默认状态和验证边界。

发送端需已有 Python3/POSIX终端及 OpenSSH；接收端需已有 Python3/Linux、支持
O_TMPFILE 的私有文件系统。工具不安装依赖，不创建 SSH 密钥、authorized_keys、
sudo规则、服务、登录项、NSG规则或隧道。不支持时明确拒绝，不降级到明文临时文件。

## 由部署任务完成的非秘密接线

先核对本包源 SHA 与全部摘要。部署任务使用**已经核验**的韩国 VM 信息填写发送
配置：固定 IP、SSH端口、现有账号、完整 Ed25519 主机公钥及 SHA256 指纹，
以及显式 `identity_file` 和 `run_as`。
公钥须由可信渠道已有记录确认；不得以首次联网扫描所得公钥自行信任。
本云端不知道这些具体值，不猜目标，也不借此请求或修改网络权限。

发送配置的正式文件名是 `key-transfer-sender.json`。源目录仅提交
`sender.example.json`；构建包已复制为正式文件名但保持关闭。配置只含非秘密
目标元数据，不能加入 API key、私钥正文或任意远程命令。

`identity_file` 只接受现有身份文件的绝对规范路径：不能含波浪号、SSH百分号
展开或控制字符，不能为符号链接/硬链接；须由当前用户持有且仅用户可读写
（0600或0400）。Python只检查文件元数据，不打开或读取私钥正文；实际授权运行
时由OpenSSH读取显式`-i`文件。固定设置`IdentitiesOnly=yes`、`IdentityAgent=none`，
不传递`SSH_AUTH_SOCK`、不加载agent、不回退其他认证方式。无法非交互使用该身份
时预检失败，不能因此把私钥或口令发进聊天、环境变量或临时文件。

`run_as` 只有两个值，不能提供用户名模板、任意shell或sudo命令。
`direct` 固定命令为：

```text
/usr/bin/python3 -I -B /opt/lingobar-key-transfer/receive.py --probe
/usr/bin/python3 -I -B /opt/lingobar-key-transfer/receive.py --receive
```

`lingobar-test` 固定命令为：

```text
/usr/bin/sudo -n -u lingobar-test -- /usr/bin/python3 -I -B /opt/lingobar-key-transfer/receive.py --probe
/usr/bin/sudo -n -u lingobar-test -- /usr/bin/python3 -I -B /opt/lingobar-key-transfer/receive.py --receive
```

这让现有SSH登录账号和目录所有者可以不同；不会新增sudoers、修改权限或建立
持续SSH入口。`-n`只禁止交互密码提示，**不保证stdin不会被sudo记录**。
sudo支持记录非TTY的标准输入，不能因输入经pipe就认为安全。

**当前阻断前提：部署侧的只读sudo查询曾被审批拒绝；实际sudo权限及stdin日志
策略尚未核实。本工具不执行该查询，也不换命令/路径规避拒绝。** 只有经授权的
独立审核确认了以下条件，才能填写`sudo_policy`：

- `permission_verified:true`：现有权限允许上述固定目标用户、脚本及两个确切模式
  非交互执行；此声明只准许工具使用这两个调用，不提供通用sudo/shell/Python
  接口。接收器及父目录不能由azureuser写入。
- `stdin_logging_disabled_verified:true`：该确切执行路径的sudo输入/I/O记录及相关
  插件不会保存密钥stdin；不是仅检查终端回显或普通命令日志。
- `evidence_id`：审核记录的非秘密编号，不含密钥、账户资料或sudo输出。

两项未确认、记录缺失或字段不合法时，在连接和取密钥前拒绝。它们是操作员审核
声明，不是工具自动验证的系统事实；不能为了开通传输自行把false改成true。
安装权限或日志策略确需变更时，由父任务另行处理最小范围；本工具不做这些变更。
审核还须覆盖对端SSH/sudo转发或监控进程的core/崩溃收集策略。接收器在exec后
设置自己的限制，不能倒过来修改那些既有进程；未知时不得运行真实密钥传输，
也不能将Python自身的保护称为已经核实对端整条进程链。

接收器代码与同目录 `key-transfer-receiver.json` 须由部署任务安全安装，不能
来自未经核对的下载。发送端在取密钥前先校验 probe 返回的接收器 SHA256，须与
本包 `receive.py` 完全一致。探测不会读取已存密钥或调用任何供应商。

接收配置指定唯一、尚不存在的 `credentialsFile`。父目录须已存在、0700且由
实际接收进程的服务用户持有；工具不提权、chown或替操作者创建任意目录。
如果现有 SSH 账号没有该用户/目录权限，停在此处，由部署任务安排最小单次
安装权限；不要增加持续 SSH 登录权限或通用免密 sudo 来绕过。

目标文件内容仅为严格 JSON `{ "apiKey": "…" }`，0600、服务用户所有，可供
PR17 固定文本测试执行器的 `credentialsFile` 使用。它不是 shell 环境文件，
不能直接当作 EnvironmentFile。普通网关目前仍使用自己的配置契约，保持关闭；
保存此文件不自动接入网关、重启服务或开始计费。ASR 密钥不在本批传输范围内。

## 用户亲自输入与传输

配置和接收器已由部署任务核验后，用户在自己的原生终端执行：

```sh
python3 -I -B send.py
```

命令本身没有密钥；**不要**把密钥写到命令后、环境变量、heredoc、重定向文件、
聊天、浏览器工具或剪贴板。本工具不读取剪贴板。只在隐藏输入提示出现后亲自
输入。输入不是 shell 命令，不进入 shell history；不要录屏、转录终端或启用调试。
如果无法取得真实 TTY、不能确认回显关闭，或 SSH 预检失败，工具拒绝继续。

发送端忽略用户/系统 SSH 配置，使用严格主机密钥检查；固定远程命令，不允许
代理、转发、连接复用、自动接受/更新主机密钥或密码交互。仅使用显式固定身份，
不会为传输新增长期权限。预检与传输是两次单独连接，各无自动重试。

密钥只进入本进程内存和 SSH stdin，不进入 argv、环境、日志、文件或 renderer。
SSH stdout/stderr 不原样转发；工具只给出有限状态。Python/SSH/内核可能保留内存
副本，工具不承诺取证级清除、禁用系统交换区或抵抗被攻陷的主机/同权限调试器。

## SIGQUIT、回显恢复与core防护

程序在读取或持有密钥前主动设置并验证`RLIMIT_CORE`软/硬上限均为0，SSH子进程
继承该限制，不假定用户终端原来的core上限。Linux的Python端还设置并验证
`PR_SET_DUMPABLE=0`，因为管道式core收集器可能忽略RLIMIT_CORE。接收器在sudo/exec
之后自行执行防护，不能只依赖发送端或父进程。

Linux启动外部SSH会重新经过exec边界，所以发送器还要求本机公开的core策略可
验证为非管道式；未知/管道式策略拒绝启动子进程，不修改内核配置。macOS按已设
硬上限约束自身及子进程；此项仍需真实Mac验证。工具不更改用户shell或既有网关
服务的limits，后续消费凭据的其他进程须有自己的防护。

SIGQUIT与INT/TERM/HUP按取消处理，发送端也处理TSTP。安装处理器和恢复TTY/关闭敏感描述符时
屏蔽受管信号并收敛重复取消；即使flush失败，也单独尝试恢复回显，然后才恢复
原处理器/信号掩码。无法建立这些保护时拒绝输入。SIGKILL、断电和被攻陷的内核
不能通过Python finally保证清理，不能把它们称作已覆盖。

## 接收器的原子保存与失败含义

输入仅为有大小和时间上限的 stdin 管道/套接字；拒绝 TTY、普通输入文件、未知
字段、其他 provider/targetId 和无效密钥。接收器无网络、解密或通用命令执行接口。

只创建最终凭据所用的私有 inode：以0600匿名 O_TMPFILE 写入并 fsync，之后原子
link 到固定目标，再 fsync 目录。没有额外命名的明文暂存文件。若匿名文件或
原子链接不受支持则拒绝，不改用 /tmp 文件；并发接收最多一个创建成功。
已存在的目标一律拒绝，不读取、覆盖、备份或回滚用户已有文件。

- `installed`：目标链接和目录持久化完成；这不证明供应商密钥有效。
- `not_installed` / `blocked`：未安装；修复非秘密配置/权限后，仍须明确重新操作。
- `outcome_unknown`：目标可能已创建，但持久化/结果确认不确定。**不要自动重发**；
  由部署任务先核查固定目标的存在性、所有者和权限，不能把未知结果当失败退款。

在目标发布前失败，关闭匿名 inode，不留下命名暂存文件；发布后的未知结果保留
目标并如实报告，不擅自删除凭据。文件系统日志、备份、用户原有副本和强制终止
的 OS 行为不属于取证擦除保证。SIGKILL/断电也不能保证终端恢复；若终端异常退出，
用户可在本机恢复终端回显，但不要因此重发密钥或改 SSH 安全策略。

## 免费测试与验证边界

```sh
npm run test:key-transfer
npm run build:key-transfer
npm run verify:key-transfer
```

测试只用 dummy secret、Linux临时目录、合成PTY和模拟SSH；阻断真实网络/供应商。
验证配置拒绝、固定指纹、先预检后输入、无回显/取消恢复、仅stdin传输、原子失败、
并发与目标已存在保护，以及默认包不连接网络。还覆盖固定identity路径与run-as
白名单、未审核sudo日志策略拒绝、非零初始core上限、SIGQUIT及清理时重复信号。
CI分别记录Python和Node版本。
Linux PTY不是 macOS 终端验收；实际 SSH 认证、韩国 VM 文件系统/服务用户、
Mac安全输入和真实密钥迁移尚需由已授权本地/部署任务分别验证。

依据：[OpenSSH配置](https://man.openbsd.org/ssh_config)、
[Python termios](https://docs.python.org/3/library/termios.html)、
[Python signals](https://docs.python.org/3/library/signal.html)、
[sudoers官方说明](https://github.com/sudo-project/sudo/blob/main/docs/sudoers.man.in)、
[Linux core](https://man7.org/linux/man-pages/man5/core.5.html)、
[Linux dumpable](https://man7.org/linux/man-pages/man2/PR_SET_DUMPABLE.2const.html)、
[Linux O_TMPFILE](https://man7.org/linux/man-pages/man2/open.2.html)、
[Linux linkat](https://man7.org/linux/man-pages/man2/linkat.2.html)。
原有项目 CC BY-NC4.0 许可保持不变；没有复制第三方实现、安装新依赖或新增采集权限。
