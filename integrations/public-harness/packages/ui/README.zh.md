---
description: "统一的团队品牌和本地化的平台额度提示。"
kind: "package-library"
---

# Public Harness 浏览器界面

[English](README.md) | 中文

## Summary

这个可安装的 Cordis 插件通过 Harness 已发布的侧栏插槽提供团队名称和标志。它接管平台 `QUOTA` 提示，使用宿主 Toast 显示英文或中文文案。路由器导入它的品牌用户选择页和就绪状态页。

## Table of Contents

- [使用此包](#use-this-package)
- [浏览器行为](#browser-behavior)
- [延伸阅读](#further-exploration)

-----

<a id="use-this-package"></a>
## 使用此包

在每位用户的 Web 配置中安装此包，禁用 `ui-brand-official` 条目，并添加此包的宿主条目。它的 `dsh.client` 元数据加载浏览器入口并声明插槽依赖。[团队开发配置](../team-dev/README.zh.md)为每位固定用户生成这一组合。插件基于已发布的 Harness 包类型构建，无需修改 Harness 源码。

<a id="browser-behavior"></a>
## 浏览器行为

侧栏标志遵循宿主提供的尺寸，名称继承宿主文字颜色。开发用户选择页和路由器页面共享标志，并支持系统浅色和深色主题。等待页面按照路由器配置的 `retryAfterSeconds` 自动刷新。容量已满和服务失败使用清楚的本地化文案。每日额度失败使用宿主语言及提示关闭机制，账号专属提示仍由其所属插件处理。安装品牌插件不会隐藏模型设置或其他官方控件。

<a id="further-exploration"></a>
## 延伸阅读

设置方法见[集成说明](../../README.zh.md)，用户路由规则见[路由器说明](../router/README.zh.md)。
