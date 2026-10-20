---
description: "仅监听本机的 Harness 多用户开发配置。"
kind: "package-library"
---

# Public Harness 团队开发环境

[English](README.md) | 中文

## Summary

`team-dev` Cordis 插件启动本机路由器，并为每位固定测试用户按需启动一个 Harness Web 进程。本机用户选择页签发带签名的测试 cookie。共享 SQLite 额度账本和各实例独立的模型监听端口提供确定性的模拟响应。它提供开发身份和进程分离，不提供 Linux 账号或容器隔离。

## Table of Contents

- [使用配置](#use-the-profile)
- [本地企业配置](#local-enterprise-profile)
- [配置](#configuration)
- [延伸阅读](#further-exploration)

-----

<a id="use-the-profile"></a>
## 使用配置

构建仓库中的 Harness CLI 和 Web 前端后，在集成项目根目录运行 `pnpm dev`。打开输出的 `/dev` 地址并选择测试用户。在模型选择器中选择 `Platform` → `Local mock model`。模拟模型返回文本及 token 用量，不生成工具调用，也不实现上游 Files API。Harness 的终端和文件系统功能使用本机开发执行环境。每位用户的数据保存在配置的 `storageRoot` 下。停止进程会关闭路由器和 Web 子进程。

若要使用真实模型而不是模拟模型，请在 profile 配置中加入 `quota.upstream`：`root` 是以 `/v1` 结尾的固定 HTTPS Messages 根地址（与生产额度服务的 `upstreamRoot` 形式相同），`keyEnv` 指定一个包含 `KEY` 的大写环境变量名，例如 `DSH_TEAM_DEV_UPSTREAM_KEY`。只为 `pnpm dev` 进程在该变量中导出平台密钥。额度代理在启动时读取它，并以 `x-api-key` 发送给上游；开发运行时会从 Harness 子进程中去除所有 `*KEY*` 变量，密钥也不会写入任何补丁、凭据文件或实例。缺少该变量时启动失败。此时模型显示为 `Platform` → `Platform model`，预留、`maxTokens` 上限和拒绝消息与生产环境一致。

<a id="local-enterprise-profile"></a>
## 本地企业配置

先构建仓库中的 CLI 和 Web 前端，再从集成项目根目录运行 `pnpm dev:enterprise`。该命令构建集成并启动具名的 `enterprise-dev` 配置。打开 `http://127.0.0.1:3080/account/login?lang=zh`。`pnpm start:enterprise` 复用集成构建。端口被占用时启动失败；请停止占用进程，或修改 `port` 后重试。

该配置通过正常的注册和邮件验证 API 创建 `admin@example.test` 和 `member@example.test`。生成的密码保存在仅属主可读的 `.enterprise-local/state/accounts.json` 中，终端会输出其绝对路径。管理员可见系统管理入口，普通成员只能访问个人中心，无法访问管理接口。身份会话、额度、知识库和独立工作区在重启后保留。开发进程共用你的操作系统账号，不提供文件系统或进程隔离。

`deploy/enterprise-dev.config.json` 提供初始账号、端口、身份限额和知识库工作线程设置；`deploy/team-dev.config.json` 提供进程和模型限制。设置 `PUBLIC_HARNESS_ENTERPRISE_HOME` 可使用另一处私有数据目录。生成器检查已有配置，遇到内容变化会拒绝启动，避免覆盖；修改初始生成设置时请使用新的 home。停止进程会关闭入口，等待子进程退出后才释放数据目录租期。

聊天和知识库编译默认使用确定性的模拟模型，二者都计入共享额度账本。按上文设置 `quota.upstream`，可为二者接入同一个真实 Messages 服务。现有的 `DSH_SSO_*` 服务变量可启用企业 SSO；该模式下启动器跳过密码账号初始化。用 `DSH_ADMIN_EMAILS` 指定真实管理员地址。外部 SSO 和真实模型凭据需要运维人员配置，不在无密钥本地检查的验证范围内。

注册和密码重置使用 `.enterprise-local/state/mailbox/` 下的本地文件邮箱。访问相应页面时附加 `?captcha=enterprise-local`；验证与重置链接保存在投递的 JSON 邮件中。默认启动器使用页面内目录选择器。本地验证码、文件邮箱和直接运行的知识库助手都是开发服务；面向托管用户请使用独立的 Linux 部署方案。

<a id="configuration"></a>
## 配置

`deploy/team-dev.config.json` 设置固定用户列表、正值的生命周期限制、等待页面刷新间隔、模型上下文和输出上限、每日 token 额度、并发数、请求大小限制和凭据轮换。插件要求监听 `127.0.0.1`，使用绝对的存储、补丁和可执行文件路径，并提供非空且不重复的用户列表。`maxActiveInstances`（至少一，至多用户数）限制同时运行的 Web 子进程数，超出后新用户看到容量已满页面。`idleStopMs`（至少两分钟）会停止没有路由请求的实例，下一次请求会用相同数据重新启动它。连接时长最长一分钟，cookie 有效期最长一小时，模型凭据最长十五分钟。`storageLock.staleMs` 和 `storageLock.updateMs` 配置数据目录的独占租期：过期时限至少五秒，心跳间隔至少一秒且不超过过期时限的一半。租期仍有效时，第二个服务器不能使用该目录。非正常停止后，过期租期可在配置的间隔后重新取得。配置生成器把私有文件写入 `PUBLIC_HARNESS_DEV_HOME` 或 `.local/`，且拒绝覆盖已修改的配置文件。

<a id="further-exploration"></a>
## 延伸阅读

设置方法见[集成说明](../../README.zh.md)，请求归属规则见[路由器说明](../router/README.zh.md)。
