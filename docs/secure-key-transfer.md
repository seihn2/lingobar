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
- 两个 `key-transfer-*.json`：默认关闭，SSH 目标、公钥和接收文件路径为空。
- `MANIFEST.json`、`SHA256SUMS.txt`：源提交、文件摘要、默认状态和验证边界。

发送端需已有 Python3/POSIX终端及 OpenSSH；接收端需已有 Python3/Linux、支持
O_TMPFILE 的私有文件系统。工具不安装依赖，不创建 SSH 密钥、authorized_keys、
sudo规则、服务、登录项、NSG规则或隧道。不支持时明确拒绝，不降级到明文临时文件。

## 由部署任务完成的非秘密接线

先核对本包源 SHA 与全部摘要。部署任务使用**已经核验**的韩国 VM 信息填写发送
配置：固定 IP、SSH端口、现有账号、完整 Ed25519 主机公钥及 SHA256 指纹。
公钥须由可信渠道已有记录确认；不得以首次联网扫描所得公钥自行信任。
本云端不知道这些具体值，不猜目标，也不借此请求或修改网络权限。

发送配置的正式文件名是 `key-transfer-sender.json`。源目录仅提交
`sender.example.json`；构建包已复制为正式文件名但保持关闭。配置只含非秘密
目标元数据，不能加入 API key、私钥或任意远程命令。

服务器固定接收命令为：

```text
/usr/bin/python3 /opt/lingobar-key-transfer/receive.py --probe
/usr/bin/python3 /opt/lingobar-key-transfer/receive.py --receive
```

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
代理、转发、连接复用、自动接受/更新主机密钥或密码交互。仅沿用现有认证能力，
不会为传输新增长期权限。预检与传输是两次单独连接，各无自动重试。

密钥只进入本进程内存和 SSH stdin，不进入 argv、环境、日志、文件或 renderer。
SSH stdout/stderr 不原样转发；工具只给出有限状态。Python/SSH/内核可能保留内存
副本，工具不承诺取证级清除、禁用系统交换区或抵抗被攻陷的主机/同权限调试器。

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
并发与目标已存在保护，以及默认包不连接网络。CI分别记录Python和Node版本。
Linux PTY不是 macOS 终端验收；实际 SSH 认证、韩国 VM 文件系统/服务用户、
Mac安全输入和真实密钥迁移尚需由已授权本地/部署任务分别验证。

依据：[OpenSSH配置](https://man.openbsd.org/ssh_config)、
[Python termios](https://docs.python.org/3/library/termios.html)、
[Linux O_TMPFILE](https://man7.org/linux/man-pages/man2/open.2.html)、
[Linux linkat](https://man7.org/linux/man-pages/man2/linkat.2.html)。
原有项目 CC BY-NC4.0 许可保持不变；没有复制第三方实现、安装新依赖或新增采集权限。
