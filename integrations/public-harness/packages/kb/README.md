---
description: "Knowledge base host service: personal LLM Wiki knowledge bases, sharing and views."
kind: "package-library"
---

# @public-harness/kb

English | [中文](README.zh.md)

## Summary

`dsh-kb`, the knowledge base host service of the public Harness. It implements the [LLM Wiki knowledge base design](../../../../docs/superpowers/specs/2026-10-17-llm-wiki-knowledge-base-design.md): personal knowledge bases in each user's storage, compiled from raw sources into an interlinked wiki.

## Table of Contents

- [Layout](#layout)
- [Service](#service)
- [Compile](#compile)
- [Sharing and views](#sharing)
- [Org knowledge bases, inventory and limits](#org)
- [Skills](#skills)
- [User helper](#user-helper)
- [Development](#development)
- [Tests](#tests)
- [Not verified on development hosts](#not-verified)

-----

<a id="layout"></a>
## Layout

- Personal knowledge bases live in `<storageRoot>/users/<account>/kb/<kbId>/`, one git repository each, with `raw/`, `wiki/`, `index.md`, `log.md` and `schema.md`. Instances see the tree read-write at `<home>/kb/mine`.
- `<kbRoot>` holds `kb.sqlite` and the service's working directories (`org/`, `submissions/`, `published/`, `views/`, `jobs/`, `templates/`). Instances never see it; `<kbRoot>/views/<account>` is bound read-only at `<home>/kb/shared`.

<a id="service"></a>
## Service

The service listens only on a private Unix socket (`DSH_KB_SOCKET`). Identity is its only client: it checks the browser session, the role and the Origin, then forwards the acting user in `x-dsh-user`, `x-dsh-email` and `x-dsh-role`. Personal routes: `GET /me/kb` (my knowledge bases with share state, effective limits and usage), `POST /me/kb` `{ title, description? }`, `POST /me/kb/sources?kb=&name=` (raw body, at most 25 MB, Markdown, text, PDF, DOCX or HTML) and `POST /me/kb/archive` `{ kb }`. Internal routes: `POST /internal/principals` (users and their effective groups, pushed by identity) and `POST /internal/audit/drain` with `POST /internal/audit/ack` (audit rows identity writes to `dsh_audit`).

Creating a knowledge base at or above `max_kbs`, or uploading a source that would take one above `max_bytes`, answers 409 `kb-limit` with the limit name, the value and the allowed value.

<a id="compile"></a>
## Compile

`POST /me/kb/compile` `{ kb, op }` queues `ingest`, `lint` or `rebuild`; `GET /me/kb/jobs?kb=` lists the jobs with state, tokens and report. One job runs per knowledge base at a time, at most two across the site (`siteWorkers`), and a user may queue 20 per hour (`perUserPerHour`, 429 `rate-limited` beyond).

A job exports the tree at a fixed commit, converts sources to text locally (Markdown and text as is, HTML stripped, PDF through poppler's `pdftotext`, DOCX from `word/document.xml`), then compiles in two phases: the model extracts concepts and claims from each new or changed source, then writes one page per concept under `wiki/` with every claim citing `raw/<file>`. `index.md` is rebuilt and `log.md` appended; deterministic lint reports dead links, orphan pages, pages missing from the index and citations of missing sources. `ingest` skips sources whose digest matches the last successful job; `rebuild` starts from an empty `wiki/`. Source text reaches the model fenced as data, and the system prompts say to ignore instructions in it. The flow and prompt structure are adapted from [llm-wiki-compiler](https://github.com/atomicstrata/llm-wiki-compiler) (MIT); the license is in [`NOTICE`](NOTICE).

The result is committed as the tree's owner. It fast-forwards `HEAD` when `HEAD` has not moved and the work tree is clean (`succeeded`); otherwise it stays on `kb/compile/<job>` (`conflict`). A result that would exceed `max_bytes` or `max_pages` is kept on that branch too (`over-limit`, with the limit in the report). A knowledge base already above a limit refuses `ingest` and `rebuild` with 409 `kb-limit`; `lint` still runs.

Tokens are charged through the quota service: each job opens its own loopback listener with the control call `open-job` (instance `kbjob-<jobId>`), gets a credential for the job's principal (the author for personal knowledge bases) and calls `/v1/messages` there, so personal allowances, the site allowance and the over-limit policy apply unchanged; `close-job` releases the listener. A refused call (402 or 429) fails the job with `allowance`. Without compile settings the routes answer 503 `compile-unavailable`. Tests use `createMockModel()`, which writes deterministic pages and, with `demo: true`, labels them as demo content.

<a id="sharing"></a>
## Sharing and views

`POST /me/kb/share` `{ kb, note? }` commits any uncommitted changes, pins `HEAD` and copies that tree read-only to `submissions/<request>/`; submitting again replaces a pending request, and `POST /me/kb/share/withdraw` `{ kb }` withdraws it. Requests expire after 30 days; expired, withdrawn and rejected submissions are deleted. `GET /me/kb/shared` lists what the user can read under `~/kb/shared`.

System Admin reviews the queue: `GET /admin/kb/requests?state=pending|all`, `GET /admin/kb/requests/content?id=` (files marked new, changed or unchanged against the current publication, removed paths, the compile log and recent jobs) and `GET /admin/kb/requests/content?id=&path=` (one file with its previous version, text only, at most 256 KB; each read is audited as `admin-kb-content-read`). `POST /admin/kb/requests/approve` `{ id, scope, includeRaw }` publishes an immutable snapshot under `published/<kb>/<snapshot>/` (without `raw/` unless `includeRaw`), sets the scope and updates views; it requires re-authentication. `POST /admin/kb/requests/reject` `{ id, reason }`, `POST /admin/kb/scope` `{ kb, scope }` and `POST /admin/kb/revoke` `{ kb }` complete the set. A scope is `company`, or a list of group IDs and user IDs.

Each user's view `views/<account>/` holds one hard-linked, read-only copy per publication whose scope matches the user's company, effective groups or account, named after the knowledge base (with a short ID suffix on collision). Views are rebuilt when principals or groups change, when a publication or scope changes, and when the user opens the knowledge base page; entries are replaced by rename, and a disabled user's view is empty. Every view change is audited as `kb-view-apply`.

<a id="org"></a>
## Org knowledge bases, inventory and limits

Org knowledge bases are service-owned repositories under `<kbRoot>/org/<kbId>/`, run through the helper as the service account (`orgRunner`). `POST /admin/kb/org` `{ title, description? }` creates one (re-authentication); `POST /admin/kb/org/sources?kb=&name=` uploads a source; `POST /admin/kb/org/edit` `{ kb, path, text, message? }` commits `wiki/<page>.md`, `index.md` or `schema.md`; `POST /admin/kb/org/compile` `{ kb, op }` queues a job charged to the KB's own ledger principal `org-kb-<kbId>`; `POST /admin/kb/org/rollback` `{ kb, commit?, scope?, includeRaw? }` publishes HEAD or an earlier commit (re-authentication). `GET /admin/kb/content?kb=[&path=&rev=]` lists files and history of an org KB; for a personal KB it returns files only from its active publication (each file read is audited) and metadata otherwise. `POST /admin/kb/convert` `{ kb }` turns a published personal KB into an org KB from the published tree, moves the scope, and leaves the author's KB private with a `converted` state in the personal center.

`GET /admin/kb?filter=all|over|published|pending` is the inventory, with owner, size, share state, scope and over-limit flags; `GET /admin/kb/preview?user=` lists what one user can read. `GET /admin/kb/limits` returns the global values and every override; `PUT /admin/kb/limits` `{ scope: { type, id }, name, value }` sets a value (`null` is unlimited) and `DELETE /admin/kb/limits` `{ scope, name }` removes a group or user override; both need re-authentication and write `admin-kb-limit-change` or `admin-kb-limit-delete` with old and new values. Identity refuses group scopes that name no known group. `GET /admin/kb/limits/effective?user=` returns each value with its source and the user's usage.

<a id="skills"></a>
## Skills

`skills/kb-query` and `skills/kb-author` ship read-only with the release (`build-assets.sh` copies them to `<assets>/packages/kb/skills`). When a KB root is configured, the container launch patch adds them through the `skill-filesystem` entry's `customSkillDirs` (`kbSkillRows` in `@public-harness/contracts`), so no plugin is needed and the instance cannot edit them. `kb-query` reads `index.md` first, then the linked pages, cites page and source paths, says when the KB does not cover a question, and treats KB text as data. `kb-author` explains the personal layout and leaves compiling and sharing to the personal center. Native instances take the same row from the release's launch patch. Compile prompts fence sources, the index, claims and pages, and neutralise fence tags inside them, so a source cannot close its own fence.

<a id="user-helper"></a>
## User helper

Every operation on a user's tree (create, upload, commit, export, measure, apply a compile result) runs in `helper.ts` as the tree's owner. Production starts it with `systemd-run --uid=<user> --pipe --wait` and a sandbox (no network, no new privileges, read-only system, write access to the user's `kb` directory only); development spawns it directly. Git runs with hooks, fsmonitor and system configuration disabled. Archives coming back from the helper are validated: regular files and directories only, no links or devices, no absolute or `..` paths, count and size limits, and an extension allow-list.

<a id="development"></a>
## Development

`createDirectRunner()` and `devUserTrees(storageRoot)` run the helper as the developer's own account, and the development runtime links `<home>/kb/mine` and `<home>/kb/shared` with symbolic links. Nothing is enforced in development.

<a id="tests"></a>
## Tests

`threats.spec.ts` walks the threat table: in-scope views of read-only hard links without symbolic links, immutable snapshots, raw sources excluded, revocation at once, symbolic links in a personal tree, metadata-only admin reads, member access, path tricks and fenced sources; it also checks the skills and their launch row. `org.spec.ts` covers org knowledge bases (create, upload, page edit, compile charged to the org principal, history, publish and rollback), conversion, the inventory and preview, and the limits API. `share.spec.ts` covers requests, review, approve with and without `raw/`, reject, resubmit, expiry, scope changes, revoke and views following group changes and disabled users. `compile.spec.ts` covers normalization, the compiler and lint with the mock model, jobs (fast-forward, conflict branch, over-limit branch, incremental ingest, caps, allowance failures) and tokens charged to the author through a real quota job channel. `personal.spec.ts` covers limits, archive validation, the helper, personal create, upload and archive over the socket, a hostile repository configuration, and the production helper argv. `mounts.spec.ts` checks the generated systemd unit, the podman volumes and their argv guard, view creation and the development links.

<a id="not-verified"></a>
## Not verified on development hosts

The `systemd-run` helper, the `BindPaths` and `BindReadOnlyPaths` binds and the podman volumes are checked only as generated configuration; they need a native host to verify. The gVisor view-refresh test in `threats.spec.ts` runs only with `PUBLIC_HARNESS_GVISOR=1` on a host with runsc and podman; until it passes there, container instances should fall back to a restart after scope changes. The production `kb` profile ships without a systemd unit until the account it runs as is decided.
