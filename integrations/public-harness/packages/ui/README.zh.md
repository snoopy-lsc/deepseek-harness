---
description: "统一的团队品牌、team-enterprise 主题、个人与系统管理导航，以及本地化的平台额度提示。"
kind: "package-library"
---

# Public Harness 浏览器界面

[English](README.md) | 中文

## Summary

这个可安装的 Cordis 插件通过 Harness 已发布的侧栏插槽提供团队名称和标志。它接管平台 `QUOTA` 提示，使用宿主 Toast 显示英文或中文文案。路由器导入它的品牌用户选择页和就绪状态页。

## Table of Contents

- [使用此包](#use-this-package)
- [浏览器行为](#browser-behavior)
- [企业主题与导航](#enterprise-theme)
- [延伸阅读](#further-exploration)

-----

<a id="use-this-package"></a>
## 使用此包

在每位用户的 Web 配置中安装此包，禁用 `ui-brand-official` 条目，并添加此包的宿主条目。它的 `dsh.client` 元数据加载浏览器入口并声明插槽依赖。[团队开发配置](../team-dev/README.zh.md)为每位固定用户生成这一组合。插件基于已发布的 Harness 包类型构建，无需修改 Harness 源码。

<a id="browser-behavior"></a>
## 浏览器行为

侧栏标志遵循宿主提供的尺寸，名称继承宿主文字颜色。开发用户选择页和路由器页面共享标志，并支持系统浅色和深色主题。等待页面按照路由器配置的 `retryAfterSeconds` 自动刷新。容量已满和服务失败使用清楚的本地化文案。每日额度失败使用宿主语言及提示关闭机制，账号专属提示仍由其所属插件处理。安装品牌插件不会隐藏模型设置；团队 Web 补丁把平台模型设为默认，并隐藏在此没有密钥的官方 DeepSeek 路由。

<a id="enterprise-theme"></a>
## 企业主题与导航

浏览器入口通过 `ctx.theme.overrideTokens` 注册 `team-enterprise` 层：只修改 `--dsw-*` 的颜色、阴影与菜单滤镜 token，因此 Harness 的按钮、图标、圆角和布局保持原样。一个插件自有的 `<style>` 元素与 ui-theme 自身的样式表一样随插件挂载和移除，提供桌面背景以及毛玻璃侧栏、输入框和对话框。它只选择 slot 名称、data 属性和 role（`[data-slot="sidebar"]`、`[data-composer-card]`、`[data-composer-seat]`、`[role="dialog"]`），从不依赖构建生成的类名。半透明表面读取 `--team-*` 属性，`prefers-reduced-transparency: reduce` 时改为实色。单元测试保证每个文字 token 在最坏桌面颜色上满足 WCAG AA（4.5:1）。

加载后插件从身份服务读取 `/account/api/me`。每位已登录用户都会在 `sidebar.panellist` 中获得个人中心入口及对应的 `main` 页面；只有服务端判定的 `admin` 角色才会增加系统管理入口。系统管理打开时，它的子菜单（用户、邀请码、审计日志、单点登录、额度和返回行）以更低优先级注册 `sidebar.workspaces`，在同一侧栏中替换会话浏览区；返回后即移除。各分区通过 `createAdminApi` 调用 `/api/admin/*`，服务端要求时显示重新认证对话框（密码或重新 SSO 登录）。审计日志分区可把筛选后的日志导出为 CSV，额度分区可切换超额策略（阻止、宽限、仅提醒）。超出额度后，`shell.overlay` 中的条目每分钟及窗口获得焦点时读取用户用量，并按状态每天显示一次宿主 Toast；拒绝提示仍经 `shell.quota-notice` 显示，个人中心在用量条上方显示同一句话。插件注入 `layout` 以跟随当前面板。宿主导出的 `identityStylesheet()` 让身份服务的账户页面使用同一套配色。

<a id="further-exploration"></a>
## 延伸阅读

设置方法见[集成说明](../../README.zh.md)，用户路由规则见[路由器说明](../router/README.zh.md)。
