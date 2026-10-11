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

向 `createQuotaLedger` 传入位于私有目录内的绝对数据库路径，以及正数的个人和全站限额。转发模型请求前调用 `reserve(userId, maximumTokens)`。收到最终用量时调用 `settle(id, actualTokens)`；请求中断或缺少用量时省略 `actualTokens`。`status()` 只提供不含用户记录的全站汇总；`inspectQuotaHealth` 将存储故障转成不可用状态。配置后的 `/internal/health` 入口需要单独的私有凭据。服务关闭时先关闭 HTTP 监听端口，再关闭账本；关闭监听端口会取消活动响应体，并等待请求清理完成。

<a id="understand-accounting"></a>
## 了解计费方式

未结算的预留按完整上限占用开始当天的额度。结算可重复调用；拿到实际用量后可释放未使用的额度。服务启动时按完整上限计入上一个进程遗留的请求，并释放其并发名额。前一天尚未结算的请求仍占用并发名额，但不消耗新一天的 token 额度。准入服务只接受已配置模型且 JSON 内容有大小上限的 Messages 请求；凭据签发服务将有效期限制在十五分钟内，并将凭据绑定到单个实例。

<a id="further-exploration"></a>
## 延伸阅读

参阅[共享用户 ID](../contracts/README.zh.md) 和[额度实现计划](../../../../docs/superpowers/plans/2026-10-10-public-harness-quota.zh.md)。

<a id="dev-note"></a>
## 开发说明

开发环境的 HTTP 入口为每个实例绑定一个本机监听地址。每日额度耗尽返回 HTTP 402，Harness 适配器将其识别为 `QUOTA`；并发限制返回 HTTP 429，表示临时限流。生产环境的控制 socket 和运行时传输仍需单独实现。每个数据库只运行一个额度服务；启动时会清理上一服务进程未完成的调用。
