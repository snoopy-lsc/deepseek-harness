# Native public Harness handoff

English | [中文](2026-10-12-public-harness-native.zh.md)

## Summary

This is the implementation handoff snapshot for 2026-10-12. Runtime Task 1 has passed independent review. Runtime Task 2 is committed with concerns and has not received independent review. Native public deployment is incomplete and admission must stay closed. The next agent should review Task 2 and resolve its browser-policy concern before continuing the remaining plans.

## Contents

- [Workspace and authorities](#workspace-and-authorities)
- [Progress and checks](#progress-and-checks)
- [Open concerns and next work](#open-concerns-and-next-work)
- [Controller decisions](#controller-decisions)
- [Local recovery artifacts](#local-recovery-artifacts)

<a id="workspace-and-authorities"></a>

## Workspace and authorities

Use `/Users/anlin/.codex/worktrees/public-harness-native-research/deepseek-harness` on branch `codex/public-harness-native-research`. The primary checkout `/Users/anlin/ai/deepseek-harness` and the older development worktree are outside this implementation scope. The implementation commits are local; this execution has not pushed them or created a pull request. The worktree is clean at this handoff's preparation point.

The [approved design](../specs/2026-10-11-public-harness-native-design.md) defines the product and security requirements. Execute the [runtime plan](../plans/2026-10-11-public-harness-native-runtime.md), then the [identity plan](../plans/2026-10-11-public-harness-native-identity.md), then the [deployment plan](../plans/2026-10-11-public-harness-native-deployment.md). Read applicable AGENTS instructions and package contracts before editing. User authorization covers sequential task implementers and independent reviews in this worktree; no further implementation task is dispatched by this handoff.

The target is one dedicated Ubuntu 24.04 LTS server, native Linux accounts/systemd/AppArmor/nftables/XFS quotas, public verified registration, separate full-function user Harness processes, platform model allowances, Git project sharing and a unified plugin interface. Existing container mode remains an explicit alternative. macOS/Windows development remains local-only. No dedicated Linux test server is available.

<a id="progress-and-checks"></a>

## Progress and checks

| Plan task | Status at handoff | Evidence or next action |
| --- | --- | --- |
| Runtime 1: service and durable backend | Complete, independent review clean | Runtime contracts, tagged configuration, v1/v2 migration and container adapter; two scoped fix rounds close all review findings. |
| Runtime 2: native host preparation | Implemented and committed, independent review pending | Native library, config/account/storage checks and policy renderers; browser concern below remains open. |
| Runtime 3: network and observed enforcement | Not started | Implement owned atomic firewall changes and actual enforcement probes. |
| Runtime 4: lifecycle and readiness | Not started | Compose provider, resource receipts, confined initialization, readiness and verified cleanup. |
| Identity 1–3 | Not started | Better Auth, live private session verification and account pages. |
| Deployment 1–2 | Not started | Native profiles/host configuration, release evidence and offline backup/restore. |
| Deployment 3 | Not started | Implement rehearsal locally; real Linux acceptance needs a dedicated host and security review. |

Implementation history contains the subjects `refactor: introduce explicit public Harness runtime providers`, `fix: synchronize public Harness admission and runtime ownership`, `fix: preserve current public Harness launch ownership` and `feat: prepare confined systemd Harness accounts`. Use the branch history for exact commit identities; the handoff is not an instruction to reset or amend them.

Task 1's independent review fixed capacity allocation before refusal, admission overwriting suspension, resumed-launch disposal ownership and stale observations replacing current ownership. Its final scoped provider tests reported 9 passed; earlier affected lifecycle tests reported 43 passed. Task 2's final six-file run reported 81 passed and 2 explicit Linux/root skips. Integration build/typecheck passed. Task 2 documentation checks reported 21 passed and doc-sync 43 passed. Root lint passed with one pre-existing unused-disable warning. The skipped descriptor/root tests and rendered policy text are not Linux enforcement evidence.

The recorded Task 2 behavior check is below. These are previously executed verification commands, not newly completed checks by the receiving agent; rebuild after changing source before testing built imports. A standalone `--` in the integration test script previously forwarded incorrectly and selected the whole integration suite, so use direct Vitest paths.

```sh
pnpm --dir integrations/public-harness run build
pnpm --dir integrations/public-harness exec vitest run --config vitest.config.ts packages/runtime-systemd/tests/host-policy.spec.ts packages/runtime-systemd/tests/storage.spec.ts packages/provisioner/tests/config.spec.ts packages/provisioner/tests/provisioning.spec.ts packages/provisioner/tests/reconcile.spec.ts packages/provisioner/tests/runtime-provider.spec.ts
pnpm --dir integrations/public-harness exec tsc --noEmit
```

Documentation checks used `pnpm run test:docs` and `env -u all_proxy -u ALL_PROXY pnpm run doc-sync`. The excluded SOCKS proxy variables cause an unrelated CLI-help diagnostic in this environment. Do not repeat already-passing broad checks solely to commit; select checks for the receiving agent's actual diff.

<a id="open-concerns-and-next-work"></a>

## Open concerns and next work

1. Review Runtime Task 2 against its brief and the decisions below before marking it complete. The [native package README](../../../integrations/public-harness/packages/runtime-systemd/README.md) owns its configuration and limitations; it is currently a preparation library, with provider registration/lifecycle still assigned to Runtime Task 4. The [provisioner README](../../../integrations/public-harness/packages/provisioner/README.md) and [upgrade guide](../../upgrade-guide/v0.2.1-alpha.2/public-harness-backends/guide.md) cover shared behavior and migration.
2. Resolve the concrete browser-policy gap. The current Chromium launcher uses an OS-selected CDP port and retains its inner sandbox. Chromium's namespace sandbox writes UID/GID maps and uses namespace capabilities/chroot; the prepared AppArmor profile does not grant the required map-write/capability operations. Full browser compatibility is therefore unverified and potentially blocked. No unconfined profile or disabled-sandbox workaround is implemented. Determine a compatible policy or transport using primary sources and real Linux evidence while retaining all mandatory outer enforcement.
3. Resolve networking compatibility before treating Web/quota-only loopback rules as full tool support. Browser CDP and other local tools can use ephemeral TCP listeners. Foreign loopback, host/private/metadata destinations, IPv6 bypass and direct public ingress to arbitrary user listeners must remain denied. Relevant code is `packages/experimental/browser-use-stagehand-native/src/launch.ts`; the plan's browser requirement and endpoint policy need an explicit resolution if they conflict.
4. Runtime Task 4 must load common config plus the referenced native options, validate immutable assets before registering `instanceRuntime`, and use exposed preparation stages to persist acquired resources between effects. Install and observe enforcement before workspace initialization. Tokens/readiness belong under private home; root management stays separate. Common account commands retain their existing runner timeout, so production composition must inject a native-budget runner if it requires native `operationTimeoutMs` throughout.
5. Keep deletion behind confirmation/recovery expiry and verified whole-cgroup/UID/process quiescence. Existing recursive data removal cannot run while a user process can race traversal. Preserve uncertain allocations and quarantine after failed cleanup; do not reuse UID/ports on guessed success.
6. Deployment must deny managed Linux accounts at SSH ingress or verify SSH absent. Locked passwords and nologin alone do not establish denial of public-key authentication/forwarding. Validate effective SSH configuration and include a real denial attempt in the rehearsal while retaining outbound Git SSH. [OpenSSH configuration](https://man.openbsd.org/sshd_config) distinguishes login denial from forwarding restrictions.
7. Real AppArmor loading/enforcement, cgroup limits, XFS byte/inode exhaustion, firewall behavior, reboot recovery, hostile-user attempts and upgrade/restore remain untested on this Mac. Implement the dedicated-host suite and evidence validator, but leave public admission closed until actual Linux evidence and security review satisfy the approved design.

<a id="controller-decisions"></a>

## Controller decisions

These decisions extend or clarify the written plans; the receiving agent must assess them against the approved design. The table retains every recorded ruling and its rework cost.

| Decision | Reason | Cost if wrong |
| --- | --- | --- |
| Separate identity Host and Client leaf TypeScript programs with a solution root. | Repository compiler-face rules. | Extra build/config files. |
| Implement Linux rehearsal locally but leave real-host acceptance pending. | No host exists; simulated approval is prohibited. | Delayed public deployment. |
| Stage explicit runtime selection; keep container assets/tools/network/linger in the container tag. | Native mode cannot require container dependencies. | Container fixture/config migration. |
| Add runtime `allocate` and durable partial pending allocation. | Complete instances require real ports and one shared launch ID. | Extra lifecycle method and adapter changes. |
| Add `releaseAllocation` for incomplete allocation recovery. | Full `stop` needs complete endpoints; uncertain cleanup cannot invent ports. | Extra cleanup method; shared cleanup implementation. |
| Resolve native config from one common configuration plus strict companion options; common systemd tag carries an absolute `configFile`. | One source for common paths/limits/ports/timeouts; native provider owns native fields. | Companion file and loader wiring. |
| Defer native filesystem preparation to its provider; record storage only after successful preparation and retain failed allocation. | Shared container ownership changes are unsafe for native root controls. | Provisioning order/test refactor. |
| Derive native root control as `stateDir/runtime/<account>`; user-readable tokens/readiness stay under home. | Management stays outside the user tree without consumer imports of native options. | Token/forwarder layout changes. |
| Permit immutable internal asset symlinks after target/ancestor validation; keep root writes descriptor-based/no-follow. | Ordinary pnpm layouts use links; writable/escaping/cyclic targets remain rejected. | More asset validation and tests. |
| Give reconciliation fixture users/service the same runtime collaborator. | Mixed real/fake ownership produced invalid cleanup evidence, reproduced on baseline. | Fixture change if diagnosis is wrong; no production API change. |

<a id="local-recovery-artifacts"></a>

## Local recovery artifacts

The ignored `.superpowers/sdd/2026-10-11-public-harness-native-runtime/` directory in this worktree contains `progress.md`, task briefs/reports, review findings and scoped diff packages. It is not included in commits and may be absent in a fresh clone. Preserve it on this host; do not clean ignored files while handing off. Task 1 is complete in that ledger; Task 2 must be recorded as implemented but review pending, not complete.

The receiving agent can regenerate a Task 2 review package from the commit immediately before `feat: prepare confined systemd Harness accounts` through that task commit. Use the approved subagent workflow and both spec/quality verdicts; do not derive a broader range that includes the handoff documentation or silently redo completed Task 1. No final whole-branch review has occurred.
