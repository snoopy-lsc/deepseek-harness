---
description: "插件市场目录：dsh-plugins 的 SQLite schema、迁移与不透明 id。"
kind: "package-library"
---

# @public-harness/plugins

[English](README.md) | 中文

## Summary

[插件市场设计](../../../../docs/superpowers/specs/2026-10-22-plugin-market-design.zh.md)的目录存储。它负责 `dsh-plugins` 的 SQLite schema（包、版本、产物、闭包、上架、范围、默认安装、策略、限额、端点、审计发件箱）、`plugin_version` 上的两个部分唯一索引，以及打开或迁移数据库的辅助函数。

## Table of Contents

- [Schema](#schema)
- [开发](#development)
- [测试](#tests)

-----

<a id="schema"></a>
## Schema

公司 scope 包名使用 `@corp-dsh/` 前缀。端点分配上限为 4,096 个账户（每用户一个 loopback 端口）。`name@version` 对应唯一的产物 sha512。每个包最多一个待审版本；被驳回、撤回或过期的版本号可以再次提交。在设置 `claimed_at` 之前，首个版本未获批准结束后清空所有者即可释放未认领的包名。

<a id="development"></a>
## 开发

```bash
pnpm --dir integrations/public-harness/packages/plugins test -- schema.spec.ts
```

用 `openPluginsDb(absolutePath)` 打开数据库。标识符为 `plg_` / `plv_` 加 16 个 base32 字符。

<a id="tests"></a>
## 测试

`tests/schema.spec.ts` 覆盖产物唯一性、待审部分唯一索引、驳回/撤回/过期后的重提，以及首个版本从未获批时的包名释放。
