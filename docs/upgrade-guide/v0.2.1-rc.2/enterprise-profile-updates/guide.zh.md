---
kind: upgrade-guide
description: "企业身份资料更新不再接受直接图片地址，也不允许修改 SSO 管理的姓名。"
---

# 企业身份资料更新

[English](guide.md) | 中文

## 变更

Public Harness 身份服务通过资料编辑器校验 `POST /api/auth/update-user`。它仅接受 `name` 和 `phone`；`image` 和其他字段返回 HTTP 400。个人和管理员接口均不能修改 SSO 管理的姓名（HTTP 403 `profile-managed`）；姓名在登录时由身份平台刷新。本地账号修改姓名仍返回 `{ status: true }`。

## 迁移

1. 将个人姓名和联系电话的修改发送到 `POST /account/api/me/profile`。工号、部门和职位使用管理员资料接口。邮箱和角色不通过资料编辑修改。
2. 将直接图片地址替换为 `POST /account/api/me/avatar`，使用 `{ mime, data }` 提交 PNG、JPEG 或 WebP 的 base64 数据，解码后不超过 512 KiB。`{ data: null }` 移除头像。
3. 在企业身份平台修改 SSO 姓名，再重新登录。通过 `GET /account/api/me/profile` 确认资料；已有登录账号和会话保留在身份数据库中。
