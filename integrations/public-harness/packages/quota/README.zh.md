---
description: "持久化的个人及全站模型 token 预留账本。"
kind: "package-library"
---

# @public-harness/quota

[English](README.md) | 中文

## Summary

此包将模型 token 预留记录保存在 SQLite 中，并在准入前检查经过签名且绑定实例的请求。在开始模型调用前，它通过同一事务检查每位用户的每日额度、全站每日额度，以及两级并发请求上限。它还负责转发 Messages 流、让 Files 元数据只归上传者所有，并通过私有凭据报告全站汇总健康状态。

## Table of Contents

- [使用此包](#use-this-package)
- [了解计费方式](#understand-accounting)
- [延伸阅读](#further-exploration)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

向 `createQuotaLedger` 传入位于私有目录内的绝对数据库路径，以及正数的个人和全站限额。转发模型请求前调用 `reserve(userId, maximumTokens)`。用最终用量调用 `settle(id, actualTokens)`；请求提前结束时传入转发器的估算值；省略 `actualTokens` 会按完整预留计费。`status()` 只提供不含用户记录的全站汇总；`inspectQuotaHealth` 将存储故障转成不可用状态。配置后的 `/internal/health` 入口需要单独的私有凭据。服务关闭时先关闭 HTTP 监听端口，再关闭账本；关闭监听端口会取消活动响应体，并等待请求清理完成。

<a id="understand-accounting"></a>
## 了解计费方式

准入按“估算输入加输出”确定每次预留：输入估算为请求体每三个字节计一个 token（不超过模型的上下文窗口）；若 `max_tokens` 超过模型配置的最大输出（生产服务中为 `maxOutputTokens`，team-dev 中为 `maxTokens`），转发的请求中会将其降到该值，而不是拒绝。未结算的预留按该大小占用开始当天的额度。结算可重复调用：完整结束的流按上游报告的用量计费（可能超过估算）；被客户端取消、流出错或上游失败而提前结束的调用，按已报告的输入（或输入估算）加上“已报告输出”与“已流出文本每三个字节一个 token”中的较大者计费，且不超过预留。服务启动时按完整上限计入上一个进程遗留的请求，并释放其并发名额。前一天尚未结算的请求仍占用并发名额，但不消耗新一天的 token 额度。准入服务只接受已配置模型且 JSON 内容有大小上限的 Messages 请求；凭据签发服务将有效期限制在十五分钟内，并将凭据绑定到单个实例。

<a id="further-exploration"></a>
## 延伸阅读

参阅[共享用户 ID](../contracts/README.zh.md) 和[额度实现计划](../../../../docs/superpowers/plans/2026-10-10-public-harness-quota.zh.md)。

<a id="dev-note"></a>
## 开发说明

开发环境的 HTTP 入口为每个实例绑定一个本机监听地址。每日额度耗尽返回 HTTP 402，并发限制返回 HTTP 429，二者都带有 Messages 风格的 JSON 错误（`error.type` 为 `quota_exceeded`），消息中写明的是平台额度而不是某个模型厂商；402 还包含 `quota.remainingTokens`、`quota.requestedTokens` 和 `quota.resetAt`（下一个 UTC 零点）。Harness 适配器把 402 识别为 `QUOTA` 并显示该消息。准入在何处停止由站点的超额策略决定（`setOverLimit(mode, gracePercent)`，账户 socket 上为 `set-over-limit`）：`block`（默认）在个人额度处停止，`grace` 在额度之外再加其 `gracePercent`（1–100）后停止，`warn` 不因个人额度停止，只剩站点每日额度；`usage()` 返回策略、用户的 `state`（`ok`、`grace`、`over`、`blocked`）和 `hardLimitTokens`。`createQuotaService` 组合出生产服务：从私有的 `0600` 文件读取平台密钥、令牌密钥和健康密钥，为每个实例在已配置的 `listenPorts` 范围内的空闲端口上打开一个绑定实例的本机监听地址（出站防火墙只允许实例访问这一段回环端口），并在汇总健康结果中按类别（个人每日、全站每日、并发、未认证、无效请求、不可用）统计拒绝次数。`startQuotaControlServer` 只在私有 Unix socket 上向 provisioner 提供 `health`、`open`、`issue` 和 `close`，诊断信息经 `sanitizeDiagnostic` 处理，令牌、凭据和路径会被遮盖。每个数据库只运行一个额度服务；启动时会清理上一服务进程未完成的调用。
