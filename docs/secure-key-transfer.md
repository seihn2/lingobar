# 一次性加密配置 DeepSeek 密钥

本工具用于已有桌面应用没有正式密钥导出接口时的**手动备用入口**。用户在自己
终端隐藏输入已有密钥；本机加密后，仅密文经过现有 Azure 管理通道。一次性接收
进程在自防护后生成私钥、解密并原子创建固定凭据文件。普通网关及收费测试不会
因此开启。本批只有代码和 dummy 测试，未执行真实迁移。

旧版明文 SSH stdin 路径已经退役：`send.py` 无参数运行及 `receive.py` 的所有
CLI 调用始终拒绝，代码中也没有 SSH 启动器。不要使用旧6813e9/b392636工具包
传输真实密钥。`send.py` 现在只保留隐藏输入/信号/core 的进程内辅助函数。

## 为什么更换传输方式

Linux 管道式 core 收集器（例如 Apport）可能忽略 RLIMIT_CORE。接收器自身设置
`dumpable=0`，不能保护中转 sshd/sudo 中曾出现的明文。因此新方案让这些中转与
Azure 命令日志只能接触密文；不关闭全机 Apport、不修改 SSH、NSG、sudoers 或
系统权限，也不需要新 SSH 私钥或持续远程入口。

现有0.1.5的 safeStorage 只在原账户 Electron 主进程使用；本工具不解密它、
不读个人配置、不后台读剪贴板，不要求聊天重发密钥。自动从旧应用提取仍未实现。
如果用户无法亲自输入现有密钥，部署任务应停在该点，不能自行复制保险库或改用
任意解密 IPC。应用及之后消费凭据的进程仍须保持各自的内存/core 防护。

## 包、依赖及默认状态

- `seal.py`：只接受无参数运行；读取固定 `key-transfer-envelope.json`。
- `session.py --serve`：Linux 前台一次性接收进程；不自动后台化、不自动重启。
- `session.py --deliver`：从 stdin 读取有界密文，投递到固定本地 Unix socket。
- `session.py --cancel`：明确取消本次会话，不读取或输出密钥。
- `receive.py`：只有进程内原子安装函数；旧明文 CLI 永久拒绝。
- `envelope_crypto.py`：调用 PyCA 的标准 RSAES-OAEP；无文件/网络/私钥序列化。
- 两个配置、MANIFEST、SHA256SUMS：全部默认关闭、目标/目录/摘要为空。

加密依赖为现有云环境已安装的 PyCA `cryptography==50.0.0`。独立部署仍需先核实
接收器和发送器的 Python3.12环境；工具不会自动安装软件。`requirements.txt`
固定 cryptography、cffi、pycparser 版本及官方 PyPI wheel 的 SHA256，只接受
Linux x86_64/macOS arm64 的对应二进制包，不允许源码构建或自动升级。已有安全
审核/安装流程可使用 `python3 -m pip install --require-hashes --only-binary=:all: -r requirements.txt`；
这不是本任务在用户设备上安装的授权或已执行事实。缺少/版本不符时，在输入前
拒绝，不降级到明文或自己实现加密。未改变 Electron/npm 的运行依赖。

项目 CC BY-NC4.0 许可保持；依赖的 Apache2/BSD/MIT 许可另见包内 notices。
PyCA 经 OpenSSL 实现 RSA，采用 RFC8017 的 RSA4096、e65537、OAEP-SHA256/
MGF1-SHA256、空 label；没有自造混合密码或本地密码算法。

## 最小非秘密接线

先由已有受信 Azure 控制通道核验本包提交与每个文件摘要，再按现有权限将代码
放到固定受信安装目录。目录/代码不能被不受信中转账户替换。接收器与本地投递
命令都以已授权的同一个 `lingobar-test` 服务身份执行；工具不调用 sudo、不查询
sudo权限，也不修改用户/目录权限。此前部署侧 `sudo -l` 查询被拒，**没有重试或
绕道，不能声称已经核实**。应利用已有 Azure 身份和已核实执行权限；如无法在
指定身份运行，停止真实迁移，不能因此扩权。

接收配置版本2（不兼容旧版本，不能偷偷迁移）：

```json
{"version":2,"enabled":false,"targetId":"lingobar-deepseek-primary","credentialsFile":null,"sessionDirectory":null}
```

部署任务填写固定凭据绝对路径及**已经存在**、归接收用户所有的0700会话目录。
两者须规范路径、无符号链接；配置须为 root/当前用户所有、不可被其他用户写入
的普通单链接文件。凭据父目录归当前用户、仅该用户可访问；已有凭据一律拒绝，
不读取、不覆盖、不备份。`sessionDirectory` 必须与凭据父目录分开，
不能让私有凭据与公开会话控制文件混用同一目录。真实文件系统须支持 O_TMPFILE 与原子 link。

发送配置版本1：

```json
{"version":1,"enabled":false,"challengeFile":null,"challengeSha256":null}
```

只填非秘密挑战文件路径及其**可信 Azure 读取确认**的 SHA256。摘要为完整规范
JSON挑战（排序字段、紧凑分隔、ASCII、尾随单个换行）的摘要，与接收器发布的
`challenge.json` 字节一致。公钥、目标、用途、会话、创建与到期时间全部被摘要
固定。仅对同一个不可信下载自行算摘要不证明公钥真实性；不得跳过这一步。

## 一次操作的数据流

1. 部署任务按已有受信权限启动 `session.py --serve`，让它在现有 Azure 受控
   执行机制下前台运行至完成/最多300秒；本工具不新增服务、端口或后台启动器。
   接收器先验证 core/dumpable、配置、锁、目标和匿名写能力，然后生成一次性
   RSA私钥。私钥仅存在这个进程内存，从不序列化或经过 Azure/sshd。
   部署任务须先用dummy确认现有Azure执行机制能维持这个临时进程，同时读取
   挑战和投递；部分RunCommand会串行化调用，不能把源码支持当成该通道已验收。
   如采用现有权限下的短期异步进程，应仍遵守300秒期限，不添加常驻服务或SSH。
2. 现有 Azure 通道读取公开 `challenge.json` 并核实摘要，转交用户本机的非秘密
   配置。目录内 `.lock`、`transfer.sock`、挑战与结果均仅包含非秘密控制数据。
3. 用户显式运行 `python3 -I -B seal.py > sealed.json`。默认关闭时不提示输入。
   启用后先验证可信摘要、参数和期限，才在 `/dev/tty` 关闭并验证回显。仅可
   亲自输入16–128个可打印ASCII字符；超长拒绝、不截断。不会从argv、env、
   文件、stdin、剪贴板、renderer或旧配置读取密钥。标准输出只有密文JSON，
   所以 `sealed.json` 不包含明文，可通过已授权 Azure 管理通道投递。
4. 现有 Azure 执行器将这个固定形状的密文交给同一服务用户的
   `session.py --deliver` stdin。无需新SSH/NSG；不要把真实密钥放进Azure命令、
   工具参数、日志或聊天。CLI不接受目标、任意shell、URL或动态文件路径参数。
5. 投递器只把密文转发到0700目录内的0600 Unix socket。接收器检查对端UID，
   在读取/解析/解密前关闭监听，首次同UID投递即耗用会话，连错误/不完整输入
   也不重试。解密后核对绑定上下文，再由同一受保护进程原子创建最终凭据。
6. 接收器清除私钥引用、关闭socket/锁/挑战，留下无密钥的 `result.json`。
   会话不自动恢复。结果及残留需由部署任务检查后显式整理，不能自动删锁重来。

这里的控制平面/本地UID仍负责授权。**OAEP不是发送者签名**：它拒绝非法/被改动
密文并校验解密上下文，但知道公钥的人也能加密另一份内容。不能把它称作已认证
发件人协议；可信Azure、公钥核验、代码/目录权限和本地UID边界不能省略。
已受攻陷的端点/root/同身份进程不属于此工具能抵抗的威胁。

## 期限、一次性与取消

挑战有效期固定300秒，绑定用途 `lingobar-deepseek-provision`、固定DeepSeek
目标、随机128位会话ID及过期时间；这些字段全部在OAEP明文内再次绑定。
密文只有512字节RSA块及严格外层字段。整个JSON明文最多446字节，超限拒绝，
没有自己拼装的对称加密步骤。实例同时用单调时钟限制私钥会话寿命；改系统时钟
不能延长接收期。发送端在输入前后重新检查期限，输入太慢则需要新显式会话。

首次同UID连接即耗用，篡改/错误目标/过期/断流均不会安装。重放不能获得第二次
解密；新会话使用全新私钥和ID。未投递时可用固定 `--cancel`，或者明确结束受控
接收进程。所有失败不自动重发、不生成替代密钥，也不启动另一项收费测试。

SIGQUIT/INT/TERM/HUP（本机还含TSTP）按取消处理。读入敏感数据前设置并验证
RLIMIT_CORE软/硬均0；Linux还独立设置并验证dumpable0，即使Apport管道开启，
接收进程也不应成为可转储进程。重复信号不能打断TTY回显恢复/敏感描述符清理。
如果core防护无法建立，在生成私钥或提示输入前拒绝。本机不启动SSH或openssl
子进程处理明文，避免exec重置dumpability。不会改变全机core或调用者shell设置。

SIGKILL/断电无法运行finally；可能留下无秘密锁/socket/挑战。私钥没有磁盘恢复
副本，旧密文不能在重启后重放。操作员必须先确认旧进程已经结束、核对目标
存在性/所有者/模式及结果，再整理明确的控制文件并手动准备新会话；工具不
提供强制删除未知锁/自动重放开关。Python/OS副本、swap、原有备份不作取证清零
保证。用户终端强制退出后也应安全恢复回显，不要自动重发密钥。

## 原子保存与结果解释

解密后只在进程内构造 `{"apiKey":...}`，用0600匿名 O_TMPFILE 写入并fsync，
之后原子link到固定目标，再fsync目录。没有额外命名的明文临时文件。最终凭据
是持续服务确实需要的私有文件；这不等于允许向聊天或日志导出它。

- `installed`：目标发布和目录持久化完成，不证明供应商接受密钥。
- `blocked` / `not_installed` / `expired` / `cancelled`：按阶段未创建目标；会话已
  耗用或不可用。先检查固定结果，不自动重发。
- `outcome_unknown`：发布/持久化/结果传回可能不确定。不要称作回滚成功；先核对
  固定目标的**存在性和元数据**，不读取正文或删除可能已经安装的凭据。

目录fsync或结果回传失败不能据此删除最终凭据。已有结果文件会阻止新会话，
让操作员明确检查。删除控制文件不会删除最终凭据，也不是重试授权。服务重启、
预算CLI真实调用和供应商密钥验证均由独立部署流程处理，本工具不执行它们。

## 已执行与未执行的验证

```sh
npm run test:key-transfer
npm run build:key-transfer
npm run verify:key-transfer
```

测试仅用dummy secret、临时Linux目录、合成PTY与本地Unix socket；没有真实
密钥/Mac/VM/SSH/Azure API/供应商请求。覆盖严格字段、公钥摘要先于输入、期限、
篡改/错会话/重放、单次消费、权限/并发/旧锁、取消/重复SIGQUIT/core、匿名原子
保存及失败结果；包默认关闭时用阻断进程/网络的仪器校验。密文可保存，不包含
私钥；日志和公开结果不含输入、私钥或原始错误。

CI构建/云Linux合成测试不等于真实Mac隐藏输入、现有Azure通道、VM身份/目录/
依赖或服务接入验收。尚须部署任务核验这些非秘密前提后，由用户显式输入；
本批不安装、不迁移、不调用费用接口。累计1元测试限制不变，不能以该工具
建成推断ASR有成本上界、普通网关已经启用或密钥已经传输。

依据：[PyCA RSA/OAEP](https://cryptography.io/en/50.0.0/hazmat/primitives/asymmetric/rsa/)、
[RFC8017](https://www.rfc-editor.org/rfc/rfc8017#section-7.1)、
[PyCA许可](https://github.com/pyca/cryptography/blob/50.0.0/LICENSE)、
[Linux core](https://man7.org/linux/man-pages/man5/core.5.html)、
[dumpable](https://man7.org/linux/man-pages/man2/PR_SET_DUMPABLE.2const.html)、
[O_TMPFILE](https://man7.org/linux/man-pages/man2/open.2.html)、
[Python signals](https://docs.python.org/3/library/signal.html)。
