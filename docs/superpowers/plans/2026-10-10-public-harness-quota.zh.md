# 公开 Harness 模型额度实施计划

[English](2026-10-10-public-harness-quota.md) | 中文

> **供执行任务的 agent 使用：** 必须使用 superpowers:executing-plans，逐项实施本计划。步骤使用复选框（`- [ ]`）跟踪。

**目标：** 为每位公开用户提供受限的平台模型 API 额度，且不把平台密钥放进 Harness 容器。

**架构：** 额度 Cordis 服务验证每用户凭据，在持久账本中预留个人与全站 token 容量，并且只向固定上游转发允许的 DeepSeek Messages 操作。正式环境将其放在独立 profile 中，平台密钥只保留在那里；仅本机可用的开发 profile 使用同一账本，连接 mock 上游或单独的开发密钥。Web profile 的 provider 每次调用时从私有文件读取已轮换的用户凭据。

**技术栈：** TypeScript、Node 22.19+ 或 24+、SQLite 事务、DeepSeek Messages API、Cordis LLM 注册、Vitest。

**规格：** [公开多用户 Harness 设计](../specs/2026-10-10-public-team-harness-design.zh.md)。

**前置工作：** 运行环境计划的任务 1–2 提供共享用户 ID 类型和开发实例管理器；正式环境还需完成其中的 Linux 任务。[运行环境计划](2026-10-10-public-harness-runtime.zh.md)。

## 全局约束

- 代码放在 `integrations/public-harness/`；正式额度服务使用独立的 `dsh` profile，开发额度服务运行于 `team-dev`，用户侧 provider 是可安装的 Cordis bundle。
- 只有正式额度服务可以读取平台密钥。每个用户运行环境取得绑定用户和实例、有效期最长 15 分钟的凭据；私有文件在到期前轮换。
- 开发环境连接 mock 上游或使用开发者单独提供的密钥；`team-dev` profile 拒绝生产凭据。
- 必须配置正数的个人与全站每日 token 额度及并发上限。账本故障、未知请求操作和缺少安全预留上界时拒绝请求。
- 成功和中断的流都只结算一次；缺失最终用量时扣除预留额。没有持久预留的请求不能转发。
- 服务只接受配置的上游源及明确支持的 Messages 和 Files 路径；拒绝重定向。
- 任务文件列表中的路径若未写出 `integrations/public-harness/` 前缀，均相对于该目录。

## 重点审查

- 多位用户争抢最后的全站 token 时不能同时预留成功；任务 1 固定原子计量。
- 错误格式或超大的请求不能申报极小预留额后消耗更多；任务 2 固定有界解析和保守准入。
- 客户端在最终用量到达前断开时，不能释放全部预留额；任务 3 固定取消时的结算。
- 过期令牌、其他实例的令牌或未知路径不能使用平台密钥；任务 2 固定拒绝行为。
- 用户提供的 URL 或上游重定向不能接收平台密钥；任务 3 固定源地址与重定向处理。

---

### 任务 1：持久额度账本

**文件：** 创建 `integrations/public-harness/packages/quota/src/ledger.ts`、`config.ts`、`tests/ledger.spec.ts`，以及该包的 README 双语文件和 manifest。

**接口：** `reserve(userId: UserId, maximumTokens: number): Promise<Reservation>` 原子计算个人与全站每日账本和进行中的请求；`settle(id: ReservationId, actualTokens?: number): Promise<void>` 有实际用量时按其结算，否则扣除预留额；`cancel` 等价于不带实际用量的 `settle`。`ReservationId` 不透明，重复结算保持幂等。

- [ ] **步骤 1：编写失败测试**，覆盖并发争抢最后额度、个人和全站耗尽、个人与全站并发、跨日未完成请求、重复结算、进程重启和存储故障。
- [ ] **步骤 2：运行** `pnpm --dir integrations/public-harness test -- ledger.spec.ts`；确认失败。
- [ ] **步骤 3：实现** 基于 SQLite 事务的预留、正数配置验证、持久进行中记录，以及重启后按预留额结算未完成请求。
- [ ] **步骤 4：运行** 聚焦测试；确认通过，然后提交账本与 README 双语文件。

### 任务 2：私有凭据与请求准入

**文件：** 创建 `packages/quota/src/tokens.ts`、`admission.ts`、`tests/admission.spec.ts`，以及 `packages/quota-provider/src/index.ts`、其 Web profile bundle 和测试。

**接口：** 正式额度服务控制 socket 只向配置服务提供 `issue(userId, instanceId): Promise<{ token: string; expiresAt: number }>`；`team-dev` 通过进程内服务签发相同凭据。用户侧 provider 通过公开的 `registerDeepSeekProvider` 注册 DeepSeek，每次调用时从私有轮换文件解析认证。`admit(request): Promise<{ userId; reservation }>` 验证令牌、操作、模型和请求大小，预留配置的模型上下文窗口上限加请求的 `max_tokens`；没有配置上下文窗口的模型拒绝使用。

- [ ] **步骤 1：编写失败测试**，覆盖过期令牌、跨实例令牌、错误签发方或签名、请求体和图像上限、缺失 `max_tokens`、不支持的模型或端点、凭据文件变化，以及没有安全上界的请求。
- [ ] **步骤 2：运行** `pnpm --dir integrations/public-harness test -- admission.spec.ts`；确认失败。
- [ ] **步骤 3：实现** 令牌签发和轮换、严格端点允许列表、有界 Messages 解析、按模型保守预留，以及 Cordis provider 接线。
- [ ] **步骤 4：运行** 聚焦测试；确认通过，然后提交准入代码和 provider bundle。

### 任务 3：计量 Messages 和文件操作

**文件：** 创建 `packages/quota/src/messages.ts`、`files.ts`、`server.ts`、`tests/stream.spec.ts` 和 `tests/files.spec.ts`。

**接口：** `forwardMessages(request, reservation): Promise<Response>` 在不缓存完整响应的情况下转发上游字节、记录上游用量，并且只结算一次。文件上传、列表与删除路径使用每用户属主记录和明确的大小、数量上限；不支持的操作在访问上游前报错。

- [ ] **步骤 1：编写失败测试**，覆盖最终用量、缺失用量、断开连接、上游错误、重试、错误 SSE、伪造文件 ID、上传上限、上游重定向和转发到任意源的尝试。
- [ ] **步骤 2：运行** `pnpm --dir integrations/public-harness test -- stream.spec.ts files.spec.ts`；确认失败。
- [ ] **步骤 3：实现** 有界流转发、只执行一次的结算、携带平台认证的固定上游请求、文件属主检查，以及故障时拒绝访问。
- [ ] **步骤 4：运行** 聚焦测试；如有测试密钥，再执行真实 provider e2e；记录实际命令与结果，然后提交。

### 任务 4：限额与故障可见性

**文件：** 创建 `packages/quota/src/health.ts`、`tests/health.spec.ts`，并在 `deploy/` 下添加部署配置。

**接口：** 私有健康与状态端点报告账本可用性、总体容量和拒绝原因类别，不暴露用户 ID、提示词、令牌或凭据。公开模型错误仅说明额度耗尽或服务不可用类别。

- [ ] **步骤 1：编写失败测试**，覆盖额度耗尽、账本故障、上游不可用、秘密信息脱敏、部署时正数限制必填、mock 开发上游，以及在 `team-dev` 中拒绝生产凭据。
- [ ] **步骤 2：运行** `pnpm --dir integrations/public-harness test -- health.spec.ts`；确认失败。
- [ ] **步骤 3：实现** 状态报告、脱敏诊断和启动配置检查。
- [ ] **步骤 4：运行** 聚焦测试和构建后的 profile smoke；确认通过，然后提交。
