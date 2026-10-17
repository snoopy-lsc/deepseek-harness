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

<a id="user-helper"></a>
## User helper

Every operation on a user's tree (create, upload, commit, export, measure, apply a compile result) runs in `helper.ts` as the tree's owner. Production starts it with `systemd-run --uid=<user> --pipe --wait` and a sandbox (no network, no new privileges, read-only system, write access to the user's `kb` directory only); development spawns it directly. Git runs with hooks, fsmonitor and system configuration disabled. Archives coming back from the helper are validated: regular files and directories only, no links or devices, no absolute or `..` paths, count and size limits, and an extension allow-list.

<a id="development"></a>
## Development

`createDirectRunner()` and `devUserTrees(storageRoot)` run the helper as the developer's own account, and the development runtime links `<home>/kb/mine` and `<home>/kb/shared` with symbolic links. Nothing is enforced in development.

<a id="tests"></a>
## Tests

`compile.spec.ts` covers normalization, the compiler and lint with the mock model, jobs (fast-forward, conflict branch, over-limit branch, incremental ingest, caps, allowance failures) and tokens charged to the author through a real quota job channel. `personal.spec.ts` covers limits, archive validation, the helper, personal create, upload and archive over the socket, a hostile repository configuration, and the production helper argv. `mounts.spec.ts` checks the generated systemd unit, the podman volumes and their argv guard, view creation and the development links.

<a id="not-verified"></a>
## Not verified on development hosts

The `systemd-run` helper, the `BindPaths` and `BindReadOnlyPaths` binds and the podman volumes are checked only as generated configuration; they need a native host to verify.
