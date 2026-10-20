---
kind: upgrade-guide
description: "Enterprise identity profile updates reject direct image URLs and changes to SSO-managed names."
---

# Enterprise identity profile updates

English | [中文](guide.zh.md)

## Change

The Public Harness identity service validates `POST /api/auth/update-user` through its profile editor. It accepts only `name` and `phone`; it rejects `image` and other fields with HTTP 400. SSO-managed names cannot be changed through either the personal or administrator API (HTTP 403 `profile-managed`); the identity provider refreshes them at sign-in. Local-account name changes keep the `{ status: true }` response.

## Migration

1. Send personal name and contact-phone changes to `POST /account/api/me/profile`. Use the administrator profile endpoint for employee ID, department and job title. Email and roles are separate from profile editing.
2. Replace direct image URLs with `POST /account/api/me/avatar`, using `{ mime, data }` for PNG, JPEG or WebP base64 bytes up to 512 KiB decoded. Use `{ data: null }` to remove an avatar.
3. Change SSO names in the enterprise identity provider, then sign in again. Confirm the values through `GET /account/api/me/profile`; existing login accounts and sessions stay in the identity database.
