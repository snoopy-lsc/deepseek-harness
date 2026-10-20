---
description: "Shared team branding, the team-enterprise theme, personal and administration navigation, and localized platform quota notices."
kind: "package-library"
---

# Public Harness browser UI

English | [中文](README.zh.md)

## Summary

This installable Cordis plugin supplies the team name and mark through Harness's published sidebar slots. It claims platform `QUOTA` notices and renders localized English or Chinese copy with the host Toast. The router imports its branded selector and readiness pages.

## Table of Contents

- [Use this package](#use-this-package)
- [Browser behavior](#browser-behavior)
- [Enterprise theme and navigation](#enterprise-theme)
- [Further Exploration](#further-exploration)

-----

<a id="use-this-package"></a>
## Use this package

Install the package in every user's Web profile, disable the `ui-brand-official` and `ui-settings-account` rows, and add the package's host row. Its `dsh.client` metadata loads the browser entry and declares its slot dependencies. The [team development profile](../team-dev/README.md) generates this composition for each fixed user. The plugin builds against published Harness package types; no Harness source edits are required.

The sidebar opens Settings directly. The official-account sign-in and contact-feedback launcher is disabled; enterprise account sign-in stays with the identity service.

<a id="browser-behavior"></a>
## Browser behavior

The sidebar mark follows the host-provided size; its name inherits the host text color. The development selector and router pages share the mark and support system light and dark themes. Waiting pages refresh after the router's configured `retryAfterSeconds`. Capacity and service failures show plain localized copy. Daily allowance failures use the host locale and dismissal lifecycle; account-specific notices remain with their owning plugin. Brand installation does not hide model settings; team Web patches set the platform model as the default and hide the official DeepSeek route, which has no key there.

<a id="enterprise-theme"></a>
## Enterprise theme and navigation

The browser entry registers the `team-enterprise` layer through `ctx.theme.overrideTokens`: only `--dsw-*` colour, elevation and menu-filter tokens change, so every Harness button, icon, radius and layout stays as shipped. One plugin-owned `<style>` element, mounted and removed with the plugin like ui-theme's own sheets, adds the desktop backdrop and the glass sidebar, composer and dialogs. It selects only slot names, data attributes and roles (`[data-slot="sidebar"]`, `[data-composer-card]`, `[data-composer-seat]`, `[role="dialog"]`), never build-generated class names. Translucent surfaces read `--team-*` properties that `prefers-reduced-transparency: reduce` turns solid. A unit test keeps every label token at WCAG AA (4.5:1) over the worst desktop colour.

After loading, the plugin reads `/account/api/me` from the identity service. Every signed-in user gets Library and Personal entries in `sidebar.panellist` with a matching `main` page; only the server-decided `admin` role adds 系统管理 (Administration). While it is open, its submenu (users, invites, audit log, SSO, quotas, and a back row) takes the place of the session browser in the same sidebar by registering `sidebar.workspaces` at a lower priority; going back removes it. Collapsed menu buttons fit the sidebar rail, and the section list scrolls within the available height without moving the account menu. The sections call `/api/admin/*` through `createAdminApi` and show a re-authentication dialog (password, or a fresh SSO sign-in) when the server asks for one. The audit section exports the filtered log as CSV, and the quota section switches the over-limit policy (block, grace, warn). Past the limit, a `shell.overlay` entry re-reads the user's usage 4.5 seconds after start-up (once the host's start-up banners have gone), every minute and on focus, and shows the host Toast (held 8 seconds) once per state and day; refusals still come through `shell.quota-notice`, and the personal center shows the same sentence above its meter. The plugin injects `layout` to follow the selected panel. The host export `identityStylesheet()` gives the identity account pages the same palette.

In Personal center, users edit their name and contact phone, upload or remove an avatar, and view their employee ID, department and job title. SSO names come from the enterprise identity provider; organization fields are maintained by administrators through Edit profile on the Users page. Email addresses and account roles are outside the profile form. Avatar uploads accept PNG, JPEG and WebP originals up to 5 MiB, resize them in the browser, and store the resulting image locally; no external image host is required.

Administration selectors use Harness menus with the same theme as the surrounding controls. Their option lists render above dialogs, fit the viewport, and support keyboard selection and Escape without submitting the form.

Library is a standalone page in the global sidebar. My materials and Team shared separate personal repositories from readable publications; administrators also get Knowledge base management and Share approvals. The page supports title and filename search, source uploads, compilation, sharing requests, directory browsing and text previews. Shared materials are read-only and show only the active publication. Personal center contains account settings; System administration keeps identity, groups, audit and quota controls.

<a id="further-exploration"></a>
## Further Exploration

See the [integration guide](../../README.md) for setup and the [router](../router/README.md) for owner routing.
