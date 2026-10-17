---
description: "知识库宿主服务：个人 LLM Wiki 知识库、共享与视图。"
kind: "package-library"
---

# @public-harness/kb

[English](README.md) | 中文

## Summary

`dsh-kb` 是公共 Harness 的知识库宿主服务。它实现了 [LLM Wiki 知识库设计](../../../../docs/superpowers/specs/2026-10-17-llm-wiki-knowledge-base-design.zh.md)：个人知识库位于每个用户的存储中，由原始资料编译成相互链接的 wiki。

## Table of Contents

- [目录结构](#layout)
- [服务](#service)
- [用户助手](#user-helper)
- [开发环境](#development)
- [测试](#tests)
- [开发主机上未验证的部分](#not-verified)

-----

<a id="layout"></a>
## 目录结构

- 个人知识库位于 `<storageRoot>/users/<account>/kb/<kbId>/`，每个知识库是一个 git 仓库，包含 `raw/`、`wiki/`、`index.md`、`log.md` 和 `schema.md`。实例在 `<home>/kb/mine` 以读写方式看到这棵树。
- `<kbRoot>` 存放 `kb.sqlite` 和服务的工作目录（`org/`、`submissions/`、`published/`、`views/`、`jobs/`、`templates/`）。实例永远看不到它；`<kbRoot>/views/<account>` 以只读方式绑定到 `<home>/kb/shared`。

<a id="service"></a>
## 服务

服务只监听私有 Unix socket（`DSH_KB_SOCKET`）。身份服务是唯一的客户端：它检查浏览器会话、角色和 Origin，然后通过 `x-dsh-user`、`x-dsh-email` 和 `x-dsh-role` 转发操作用户。个人接口：`GET /me/kb`（我的知识库及其共享状态、生效限额和用量）、`POST /me/kb` `{ title, description? }`、`POST /me/kb/sources?kb=&name=`（原始请求体，最大 25 MB，Markdown、文本、PDF、DOCX 或 HTML）和 `POST /me/kb/archive` `{ kb }`。内部接口：`POST /internal/principals`（用户及其生效用户组，由身份服务推送），以及 `POST /internal/audit/drain` 与 `POST /internal/audit/ack`（由身份服务写入 `dsh_audit` 的审计记录）。

在达到或超过 `max_kbs` 时创建知识库，或上传会使知识库超过 `max_bytes` 的资料，会返回 409 `kb-limit`，并给出限额名称、当前值和允许值。

<a id="user-helper"></a>
## 用户助手

对用户目录树的所有操作（创建、上传、提交、导出、统计、应用编译结果）都在 `helper.ts` 中以目录所有者的身份运行。生产环境用 `systemd-run --uid=<user> --pipe --wait` 启动它并施加沙箱（无网络、禁止提权、系统只读、只能写用户的 `kb` 目录）；开发环境直接启动。git 运行时禁用 hooks、fsmonitor 和系统配置。助手返回的归档都会校验：只允许普通文件和目录，不允许链接或设备，不允许绝对路径或 `..`，有数量和大小上限，并按扩展名白名单过滤。

<a id="development"></a>
## 开发环境

`createDirectRunner()` 和 `devUserTrees(storageRoot)` 以开发者自己的账户运行助手，开发运行时用符号链接提供 `<home>/kb/mine` 和 `<home>/kb/shared`。开发环境不做任何强制隔离。

<a id="tests"></a>
## 测试

`personal.spec.ts` 覆盖限额、归档校验、助手、通过 socket 的个人创建、上传与归档、恶意仓库配置以及生产助手参数。`mounts.spec.ts` 检查生成的 systemd unit、podman 卷及其参数校验、视图目录创建和开发环境链接。

<a id="not-verified"></a>
## 开发主机上未验证的部分

`systemd-run` 助手、`BindPaths` 与 `BindReadOnlyPaths` 绑定以及 podman 卷只按生成的配置检查；需要在原生主机上验证。
