# 原生公开 Harness 部署提案

[English](2026-10-11-public-harness-native-design.md) | 中文

## Summary

本文是一份参考规格，为[公开 Harness 服务](2026-10-10-public-team-harness-design.zh.md)提出无容器的 Linux 部署方案。它是供审阅的设计，尚未实现，也不代表已获得 Linux 隔离验证结果。产品需求沿用公开自助注册、完整代码工具、私有会话、通过 Git 共享项目、平台承担模型费用并限额，以及统一的插件界面。macOS 和 Windows 保留仅监听本机的开发运行方式。

## Contents

- [部署选择](#deployment-choice)
- [服务职责](#service-ownership)
- [宿主机强制限制](#host-enforcement)
- [身份与注册](#identity-and-registration)
- [生命周期与持久化](#lifecycle-and-persistence)
- [集成改动](#integration-changes)
- [验证与发布](#verification-and-release)
- [资料来源](#sources)

<a id="deployment-choice"></a>
## 部署选择

拟新增的原生运行后端通过 systemd 系统服务，为每个持久化 Linux 账号启动一个 Harness 进程。它不依赖 Docker、Podman、OCI 镜像、gVisor、Kubernetes 或虚拟机。systemd 的文件系统与 IPC 保护可能在内部使用 Linux namespace；部署仍通过安装普通宿主机程序和管理系统服务完成。现有容器后端保留为显式选择的另一套部署配置。

| 方式 | 优点 | 成本或限制 |
| --- | --- | --- |
| 账号、systemd、AppArmor、防火墙与配额 | 共享宿主工具链，直接管理进程，无需构建镜像或运行容器引擎 | 共享内核；策略兼容性与恶意代码隔离需要真实 Linux 验证 |
| 每用户一个 MicroVM | 独立客户机内核 | 需要虚拟化支持、客户机文件和虚拟机生命周期管理 |
| 现有 Podman 与 gVisor 后端 | 复用现有容器实现 | 需要容器引擎和镜像 |

本次提案选择原生运行后端。初始验证目标为专用 Ubuntu 24.04 LTS 主机，启用 cgroup v2、AppArmor 强制执行、nftables，以及开启 XFS 配额的数据卷。其他发行版和 CPU 架构需要各自的验证结果才能开放实例准入。原生进程限制不提供独立内核，其隔离能力不等同于 MicroVM。

<a id="service-ownership"></a>
## 服务职责

```text
Browser -> Caddy HTTPS -> router -> private Unix forwarder -> user Harness
                            |
                            +-> identity service (Better Auth)
                            +-> privileged provisioner -> systemd system unit
user Harness -> instance-bound quota listener -> quota service -> platform model
```

Caddy 是应用唯一的公开入口。路由器、身份服务、额度服务和配置服务通过限制权限的 Unix socket 通信。每个可信服务使用独立服务账号；仅配置服务执行范围受限的 root 操作。所有 Node 服务通过专用 dsh 配置启动。身份服务的公开认证接口经 Caddy 暴露，会话验证接口保持私有。

配置服务复用不透明用户 ID 映射来创建持久化账号。账号锁定密码、使用 nologin shell，不开放 SSH，也不加入管理组。原生实例不需要 systemd 用户管理器或 loginctl linger。root 拥有的系统单元通过 User 和 Group 选择账号。网页用户不能提交 Linux 名称、UID、可执行文件、单元文件、策略内容或文件路径。

共享 Harness 发布文件、Node 运行时、插件和工具链归 root 所有，对用户账号只读。每个账号拥有可写的私有 Harness home、工作区、依赖缓存和临时目录。宿主 Unix 转发器可复用现有实现，仅连接为该实例分配的 Web 本机端口，不需要容器 sidecar。就绪消息必须匹配配置服务已分配的实例和端口，不能从用户可修改的数据中选择转发目标。

特权文件操作使用 root 拥有的控制目录和不跟随链接的路径访问；不得递归遍历用户可修改的工作区来执行 root 的权限或归属变更。用户目录中的链接、替换后的文件与恢复记录均视为不可信输入。

<a id="host-enforcement"></a>
## 宿主机强制限制

保护覆盖整个 Harness 进程树，包括终端、shell、Git hook、语言服务器、扩展和子代理。修改 Cordis 配置或请求 Harness 沙箱提权都不能解除宿主限制。root 拥有的配置在产生副作用之前进行验证，缺失强制限制时拒绝实例准入。

| 控制 | 必须满足的行为 |
| --- | --- |
| 文件与进程 | AppArmor 允许必要的系统读取和本账号数据写入；禁止访问其他用户的数据、平台密钥和管理 socket。执行子程序时保持限制，不允许切换到无约束状态。进程检查和信号不能跨账号。 |
| 权限 | 禁止获取新权限，不授予 capability，不允许 setuid 提权、修改策略或单元，也不允许通过服务管理 socket 或可写的委托 cgroup 绕过限制。 |
| 资源 | cgroup v2 的 CPU、内存和任务数量限制覆盖后代进程；磁盘字节与 inode 配额覆盖所有可写的磁盘目录。私有临时空间必须有上限，计入用户磁盘或内存额度。 |
| 设备与兼容性 | 只允许代码执行和 PTY 所需设备。保留 Node JIT、编译器和无头浏览器功能；系统调用与 namespace 限制依据兼容性验证选择，不能假定某个严格预设可用。 |

网络策略在首个进程启动前安装。nftables 根据已记录 UID，允许该用户分配到的 Web 和额度本机端点、配置的 DNS 解析器，以及配置允许的公网出站。同一用户自己的进程之间可在任意端口建立回环连接：output 钩子用发送方 socket 的 UID 标记每个新的回环连接（`ct mark set meta skuid`），input 钩子在目标 socket 属于该用户 unit cgroup（`socket cgroupv2`）且标记不等于该用户 UID 时丢弃新连接。因此开发服务器、语言服务器和浏览器调试端口对属主可用，其他账户都无法连接。加载规则时 cgroup 路径必须已存在，所以规则在 unit 的 cgroup 创建之后、用户代码启动之前安装。禁止其他用户的回环监听、其他本机服务、宿主地址、私网与链路本地范围、云元数据，以及未批准的 IPv4 和 IPv6 目标。不能在用户限制之前用一条通用的已建立连接规则绕过检查。Unix socket 除 IP 规则外还需要文件权限和 AppArmor 限制。公开入口禁止直接连接用户进程，包括终端中自行启动的任意监听服务。实例只通过 root 生成的 `resolv.conf` 解析域名，其中只列出配置的解析器，并以只读方式绑定到 `/etc/resolv.conf`；因此宿主的 `/etc/resolv.conf` 必须是普通文件，而不是 systemd-resolved 的 stub 链接。

停止或停用实例时撤销路由与额度授权，阻止新连接，关闭已有转发，并停止整个 cgroup。防火墙变更必须原子应用，保留宿主无关规则。在清理完进程、连接、socket 和授权之前，不得复用 UID 或端口。清理失败时将实例保留为隔离状态，禁止复用。

用户可以在私有目录安装依赖、编译程序、执行命令，以及使用 Git 和终端。用户不能以 root 安装宿主软件或管理服务器。浏览器自动化必须在相同的外层限制下通过验证，不能关闭强制保护。本次改造不发布任意项目预览服务器；未来的预览托管需要单独设计浏览器 origin 和路由。 Chromium 保留其命名空间沙箱：账户的 AppArmor profile 没有 `userns` 规则，只有固定版本、root 拥有的 Chrome for Testing 可执行文件会进入子 profile，该子 profile 可以创建用户命名空间、持有命名空间内的 `sys_admin`、`sys_chroot`、`setuid` 和 `setgid` 能力，并写入自身的 UID/GID 映射。不使用 `--no-sandbox`，也不使用不受限 profile。Harness 通过 `--remote-debugging-pipe` 控制自有浏览器。由于固定版本 Stagehand SDK 的浏览器内扩展需要 WebSocket 端点，Chromium 还会在回环调试端口上监听，并且只接受该扩展的来源；仅限属主的回环规则阻止其他账户访问它。

<a id="identity-and-registration"></a>
## 身份与注册

拟新增的原生身份服务是仓库外插件形式的 TypeScript Cordis 包，封装 Better Auth，使用 ESM Node handler 和私有 SQLite 身份数据库。它负责邮箱密码注册、验证、登录、退出、密码重置和会话撤销。CAPTCHA、可信代理地址、可信 origin、cookie 属性、邮件投递和持久化请求限速均为经过验证的部署配置。未验证账号不能创建实例。容量上限可以拒绝已验证账号的首次启动。

路由器增加显式选择的生产身份实现，在每次 HTTP 请求和 WebSocket 握手时向私有身份服务验证浏览器会话。它把不可变数据库用户 ID 映射为现有的品牌类型 UserId，并检查邮箱验证与账号状态。它不接受浏览器传入的身份头，也不在生产中启用开发 cookie。现有 authentik 身份实现保留为原有部署可独立选择的实现。原生部署不依赖 authentik、其 outpost 或容器。

身份查询或数据库失败时不允许降级放行。原生会话验证不能使用在退出或停用后仍有效的成功缓存。已有 WebSocket 保留配置的最长生存期，重连时重新认证；停用还会请求关闭活跃连接。注册、创建实例与授予模型额度是独立的幂等操作，因此注册网站账号不会立即预留 Linux 进程。

登录与账号页面使用我们自己的 React 组件和共享视觉变量。现有 Harness 界面插件负责每个实例内的品牌。隐藏官方模型控件仍是单独工作。平台模型密钥保留在额度服务中；实例仅获取自己的、轮换且绑定实例的额度凭据，沿用现有个人和全站限额。

<a id="lifecycle-and-persistence"></a>
## 生命周期与持久化

首次启动验证身份、预留容量、核对 Linux 账号与私有存储、落实磁盘配额、分配私有端点、安装策略和防火墙规则、授予额度凭据，最后启动系统单元。只有强制限制检查、带认证的 Web 就绪检查和归属检查通过后，路由器才发布端点。同一用户并发启动请求加入同一操作。失败步骤留下可核对恢复的持久化状态，且该状态不可路由。

空闲停止保留数据；唤醒时重新检查强制限制和就绪状态。停用拒绝新访问并停止进程树。删除沿用现有确认删除与恢复期规则。重启恢复将真实 systemd 状态和 cgroup 成员与持久化记录核对；不能把未知状态报告为已停止。root 配置服务的任务，包括 Git 初始化，不能在用户受限单元外运行不可信 hook 或仓库代码。

持久化记录标明运行后端及其分配的单元、UID 和端点。记录格式变更需要在重写已部署数据之前实现版本化迁移和恢复测试。现有记录显式解释为原有容器后端；不得静默迁移用户运行方式。后端切换是管理员控制的离线操作，需要备份、完全停止和恢复验证。新增运行后端不改变 Harness 会话格式或用户工作区。

<a id="integration-changes"></a>
## 集成改动

保持路由器的 InstanceManager 操作和私有端点表示。将通用账号、存储、额度和生命周期配置与后端专用设置分开。运行配置使用经过验证的带标签选择；原生配置不要求也不探测 Podman、runsc、镜像或容器网络。运行状态名称和生命周期接口必须描述进程实例，不能假定实例是容器。

通过共享服务定义、systemd 和现有容器运行实现，以及配置服务消费者，完整提供运行能力。新增 runtime-systemd 包负责生成单元、检查强制限制和查询 systemd 生命周期。identity 包负责 Better Auth 集成，路由器消费其私有验证操作。公开代码保留在 integrations/public-harness 和文档化的 Cordis 扩展点内；不需要修改 agent-loop 或添加会话授权补丁。

实现拆为原生运行与强制限制、原生身份与登录、生产组合与发布验证三部分。每部分需要经过审阅的实施计划。发布证据绑定真实后端、策略、主机和发布版本，因此容器测试不能批准原生部署，模拟测试不能批准 Linux 限制。

<a id="verification-and-release"></a>
## 验证与发布

macOS 和 Windows 本机测试可验证非法配置拒绝、安全命令参数、单元与策略生成、生命周期竞态、身份集成，以及现有本机开发流程。它们不能证明 Linux 强制限制。本提案不提供可执行部署命令，因为新增服务组合尚未实际运行。

Linux 发布演练必须验证邮箱注册与验证、两名用户的完整 Harness 流程、PTY 命令、模型限额、安装依赖、Git、语言服务器和无头浏览器自动化。攻击性检查必须尝试跨用户读写、链接、进程检查、信号、Unix socket 访问、本机和私网连接、IPv6 绕过、外部直连入口、提权、通过插件删除策略以及子进程逃逸。实际耗尽 CPU、内存、任务数量、磁盘字节与 inode 时，必须落实配置限制且不影响另一个账号。

演练还必须覆盖服务停止、宿主重启、并发首次启动、伪造就绪消息、防火墙失败、AppArmor 禁用或处于 complain 模式、策略被删除、cgroup controller 不可用、配额不生效、凭据撤销、身份或计费数据库不可用，以及 cgroup 清理失败。必须用实际部署版本验证金丝雀升级、备份恢复和会话保留。公开注册允许启动工作负载之前，需要安全审阅和真实强制限制结果；仅生成配置或查看 systemd 安全评分不足以批准发布。

目前没有 Linux 验证主机，因此公开工作负载准入保持关闭。即使这些检查通过，共享内核漏洞与宿主整体资源耗尽仍是残余风险；运维需要宿主安全更新、容量预留和滥用处置。如果无法在选定主机证明所需保护，MicroVM 仍可作为替代方式。

<a id="sources"></a>
## 资料来源

技术选型依据以下一手资料；上文服务组合和验收规则是拟定的项目决策。

- [systemd 执行控制](https://manpages.ubuntu.com/manpages/noble/man5/systemd.exec.5.html)：账号选择、AppArmor 绑定和保护措施兼容性。AppArmor 禁用时绑定不生效，因此必须进行实际行为检查。
- [systemd 资源控制](https://manpages.ubuntu.com/manpages/noble/man5/systemd.resource-control.5.html)：cgroup 资源设置。
- [AppArmor 策略语法](https://manpages.ubuntu.com/manpages/noble/man5/apparmor.d.5.html)：继承和无约束执行权限。
- [nftables socket 身份匹配](https://wiki.nftables.org/wiki-nftables/index.php/Matching_packet_metainformation)：按发起 socket 的 UID 选择规则。
- [XFS 配额](https://manpages.ubuntu.com/manpages/noble/man8/xfs_quota.8.html)：强制磁盘与 inode 限额。
- [Better Auth Node/Express 集成](https://better-auth.com/docs/integrations/express)、[邮箱验证](https://better-auth.com/docs/authentication/email-password)、[CAPTCHA](https://better-auth.com/docs/plugins/captcha)和[持久化限速](https://better-auth.com/docs/concepts/rate-limit)。
- [OpenShell 运行环境](https://docs.nvidia.com/openshell/latest/how-it-works/sandboxes/runtimes)：文档列出的内置选择为 Docker、Podman、MicroVM 和 Kubernetes。没有文档化的内置宿主进程实现；开发扩展 driver 会增加一项需要维护的集成。
