---
description: "Runbook for the native deployment order and the privileged Phase 0 rehearsal (P0.4, P0.5, P0.8) on a dedicated systemd host."
kind: "package-library"
---

# Native deployment and P0 rehearsal runbook

English | [中文](README.zh.md)

## Summary

This runbook gives the order for bringing up a native host and the privileged Phase 0 checks that the plugin market design left open. The checks are P0.4 (the reconcile transient unit), P0.5 (`meta skuid` matching) and P0.8 (the listener cgroup of the market socket and the `dsh_market` loader). [p0-rehearsal.sh](p0-rehearsal.sh) runs them on a dedicated rehearsal host as root. It refuses to run anywhere else, and `--dry-run` prints the plan without touching the host. None of these checks has run on a real host yet.

## Table of Contents

- [Deployment order](#deployment-order)
- [Before the rehearsal](#before-the-rehearsal)
- [Run the P0 rehearsal](#run-the-p0-rehearsal)
- [What each probe checks](#what-each-probe-checks)
- [Results and evidence](#results-and-evidence)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="deployment-order"></a>
## Deployment order

1. Prepare the host and install the release as in [Install on a dedicated host](../README.md#install-on-a-dedicated-host), including Node.js 24.9 or later.
2. Run `host-preflight.ts` and fix every failed check.
3. Stamp the shipped native manifest with the installed policy and toolchain digests (see [Validate before admission](../README.md#validate-before-admission)).
4. Run the P0 rehearsal below and keep its evidence directory with the release records.
5. Run `runNativeRehearsal` with `DSH_NATIVE_REHEARSAL=dedicated-host` and pass its evidence to `validateNativeEvidence`. Public enrollment stays closed until that evidence is accepted.

<a id="before-the-rehearsal"></a>
## Before the rehearsal

Use a host that runs nothing else and that you may restart services on. The script needs root, a running systemd (`/run/systemd/system`) and `DSH_NATIVE_REHEARSAL=dedicated-host`. It also needs `systemd-run`, `nft`, `ss`, a Node.js 24.9 toolchain and a pnpm binary. It uses an existing unprivileged account (default `nobody`) and a free loopback port (default 28672). P0.4 and P0.5 report `BLOCKED` when another process already holds that port. For P0.8, install the market firewall as in [Market firewall](../README.md#market-firewall) and start `dsh-plugins.socket`. Its `ExecStartPost=/usr/lib/dsh-public/load-dsh-market.sh /etc/dsh-public/dsh-market.nft` is fatal (no `-` prefix), so the socket does not start without the `dsh_market` table. The owner checks need the `--account` user to have no `market_owner` element and two `ListenStream` ports for the cross-port check. The container part of P0.5 also needs rootless Podman, gVisor `runsc`, `pasta` and an instance image that contains `node`.

Read the plan first:

```bash
deploy/native/rehearsal/p0-rehearsal.sh --dry-run
```

<a id="run-the-p0-rehearsal"></a>
## Run the P0 rehearsal

```bash
sudo DSH_NATIVE_REHEARSAL=dedicated-host deploy/native/rehearsal/p0-rehearsal.sh --account dsh-p0 --node /opt/dsh-public/toolchain/node --pnpm /opt/dsh-public/toolchain/pnpm
```

`--only P0.4,P0.8` selects probes. `--evidence-dir` sets the evidence directory, which must not exist yet. `--probe-port` and `--socket-unit` change the port and the market socket. `--market-loader` names the installed loader (default `/usr/lib/dsh-public/load-dsh-market.sh`). `--container --container-image <image>` adds the pasta part of P0.5. Every probe resource is named `dsh-p0-*`, `dsh_p0_probe` or `dsh_p0_mark` and is removed on exit. The script never flushes or deletes the `dsh_market` table. P0.8 adds one temporary `market_owner` element for the `--account` uid and deletes that element again, also on an early exit. Before any probe, the script unsets model credential variables (`DSH_MODEL_*`, `*_API_KEY` and the provider prefixes). P0.8 restarts the market socket, which is why the host must be dedicated.

<a id="what-each-probe-checks"></a>
## What each probe checks

| Probe | Passes when |
| --- | --- |
| P0.4 | A `systemd-run --wait --collect` unit in `dsh-p0-probe.slice`, running as the account with the reconcile properties, sees the slice in `/proc/self/cgroup`. It reaches 127.0.0.1 and is refused (`EPERM`) for 192.0.2.1 under `IPAddressDeny=any` and `IPAddressAllow=localhost`. A throwing `.pnpmfile.cjs` stops a plain `pnpm install --offline` with `hostile pnpmfile executed` in its output, and `--ignore-pnpmfile --config.userconfig=/dev/null` skips it and the hostile `.npmrc`. |
| P0.5 | An output rule with `meta skuid <account uid>` counts the account's loopback connection and not root's, and a `meta skuid 0` rule counts only root's. With `--container`, a connection from a `runsc` container through `pasta:--map-host-loopback` also counts under the account's uid. Without it, P0.5 reports `SKIP`. |
| P0.8 | A connection to the market socket's port names its listener cgroup: level 1 `init.scope` or level 2 `system.slice/dsh-plugins.socket`. The `dsh_market` table exists, and its `market_listener` rule names that cgroup. Both still hold after `systemctl restart dsh-plugins.socket`. The socket runs the loader as a fatal `ExecStartPost`. With a temporary `ct mark set meta skuid` table, the account without an element and unmarked root are both denied. Then a temporary element is added: rerunning the loader keeps it, the owner reaches its own port and not a second market port, and after the element is deleted the owner is denied again. P0.8 reports `SKIP` when the owner checks cannot run. |

The one-shot reconcile container argv (`assertSafeReconcileArgv`) is covered by unit tests, not by this script.

<a id="results-and-evidence"></a>
## Results and evidence

Each probe prints one line: `PASS`, `FAIL`, `SKIP` or `BLOCKED`, followed by the reason. The exit code is 0 only when every selected probe passed. It is 1 when any probe failed, 3 when one was skipped or blocked (incomplete, never a pass) and 2 when the script refused to run. The evidence directory (default `/var/lib/dsh-public/rehearsal/p0-<UTC time>`) is mode 0700 and its files are 0600. It holds `host.txt` (kernel, systemd and nft versions, and a SHA-256 of the machine ID), one log per probe with every command and its output, and `summary.tsv`. The script never prints the environment. Output that looks like a key, token, password or private key is masked before it reaches the terminal or a file.

<a id="further-exploration"></a>
## Further Exploration

See the [native deployment guide](../README.md), the [plugin market plan](../../../../../docs/superpowers/plans/2026-10-23-plugin-market.md) and the [Phase 0 results](../../../../../docs/superpowers/plans/phase0-results.md).

<a id="dev-note"></a>
## Dev Note

`tests/p0-rehearsal.spec.ts` checks the script with `bash -n`, `shellcheck` when installed, the dry-run plan, the refusals and the masking. The tests never run the probes.
