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
- [编译](#compile)
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

<a id="compile"></a>
## 编译

`POST /me/kb/compile` `{ kb, op }` 把 `ingest`、`lint` 或 `rebuild` 加入队列；`GET /me/kb/jobs?kb=` 列出任务及其状态、token 用量和报告。每个知识库同一时间只运行一个任务，全站最多同时运行两个（`siteWorkers`），每个用户每小时最多排入 20 个（`perUserPerHour`，超出返回 429 `rate-limited`）。

任务在固定的提交上导出目录树，在本机把资料转换成文本（Markdown 和文本原样保留，HTML 去掉标签，PDF 用 poppler 的 `pdftotext`，DOCX 读取 `word/document.xml`），然后分两个阶段编译：模型先从每份新增或修改的资料中提取概念和论断，再为每个概念在 `wiki/` 下写一个页面，每条论断都引用 `raw/<file>`。随后重建 `index.md` 并追加 `log.md`；确定性检查会报告死链、孤立页面、未列入索引的页面以及引用了不存在资料的地方。`ingest` 跳过摘要与上一次成功任务相同的资料；`rebuild` 从空的 `wiki/` 开始。资料文本以数据的形式包裹后交给模型，系统提示要求忽略其中的指令。这一流程和提示结构改编自 [llm-wiki-compiler](https://github.com/atomicstrata/llm-wiki-compiler)（MIT），许可证见 [`NOTICE`](NOTICE)。

结果以目录树所有者的身份提交。如果 `HEAD` 没有移动且工作区干净，就快进 `HEAD`（`succeeded`）；否则保留在 `kb/compile/<job>` 分支（`conflict`）。会超过 `max_bytes` 或 `max_pages` 的结果也保留在该分支（`over-limit`，报告中给出对应限额）。已经超过限额的知识库会以 409 `kb-limit` 拒绝 `ingest` 和 `rebuild`；`lint` 仍可运行。

token 通过配额服务计费：每个任务用控制调用 `open-job` 打开自己的回环监听（实例为 `kbjob-<jobId>`），为任务的计费主体（个人知识库为作者）取得凭据并在那里调用 `/v1/messages`，因此个人额度、全站额度和超额策略都照常生效；`close-job` 释放监听。被拒绝的调用（402 或 429）会让任务以 `allowance` 失败。没有编译配置时这些接口返回 503 `compile-unavailable`。测试使用 `createMockModel()`，它生成确定性的页面，设置 `demo: true` 时会把页面标注为演示内容。

<a id="user-helper"></a>
## 用户助手

对用户目录树的所有操作（创建、上传、提交、导出、统计、应用编译结果）都在 `helper.ts` 中以目录所有者的身份运行。生产环境用 `systemd-run --uid=<user> --pipe --wait` 启动它并施加沙箱（无网络、禁止提权、系统只读、只能写用户的 `kb` 目录）；开发环境直接启动。git 运行时禁用 hooks、fsmonitor 和系统配置。助手返回的归档都会校验：只允许普通文件和目录，不允许链接或设备，不允许绝对路径或 `..`，有数量和大小上限，并按扩展名白名单过滤。

<a id="development"></a>
## 开发环境

`createDirectRunner()` 和 `devUserTrees(storageRoot)` 以开发者自己的账户运行助手，开发运行时用符号链接提供 `<home>/kb/mine` 和 `<home>/kb/shared`。开发环境不做任何强制隔离。

<a id="tests"></a>
## 测试

`compile.spec.ts` 覆盖资料转换、使用模拟模型的编译与检查、任务（快进、冲突分支、超限分支、增量编译、上限、额度失败），以及通过真实配额任务通道计入作者的 token。`personal.spec.ts` 覆盖限额、归档校验、助手、通过 socket 的个人创建、上传与归档、恶意仓库配置以及生产助手参数。`mounts.spec.ts` 检查生成的 systemd unit、podman 卷及其参数校验、视图目录创建和开发环境链接。

<a id="not-verified"></a>
## 开发主机上未验证的部分

`systemd-run` 助手、`BindPaths` 与 `BindReadOnlyPaths` 绑定以及 podman 卷只按生成的配置检查；需要在原生主机上验证。
