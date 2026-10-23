/**
 * Native pre-start reconcile transient unit (design § Fallback: pre-start reconcile).
 * Fixtures only on this box — P0.4 live systemd-run remains blocked.
 */
import type { RuntimeInstance } from '@public-harness/contracts'
import type { SystemdConfig } from './config.ts'
import { unitSlice } from './network.ts'

/** Env keys passed via `--setenv` (exact allowlist; no root inherit, no model key). */
export const RECONCILE_UNIT_ENV_KEYS = [
  'HOME',
  'DSH_HOME',
  'XDG_CACHE_HOME',
  'TMPDIR',
  'PATH',
  'NPM_CONFIG_GLOBALCONFIG',
] as const

export interface ReconcileUnitInput {
  readonly instance: RuntimeInstance
  readonly config: SystemdConfig
  /** Root-owned per-account npmrc (`instance-market/<account>.npmrc`). */
  readonly npmGlobalConfig: string
}

export interface ReconcileSystemdRunInput extends ReconcileUnitInput {
  /** Absolute path of the release reconcile entry (node script). */
  readonly entryPath: string
  /** Absolute path of the plan JSON written by the provisioner. */
  readonly planPath: string
}

/**
 * Unit properties modeled on `initializeWorkspace`, with loopback-only network
 * (`IPAddressDeny=any` + `IPAddressAllow=localhost`) and `RuntimeMaxSec=300`.
 */
export function renderReconcileUnitProperties(input: ReconcileUnitInput): string[] {
  const { instance, config } = input
  const { home, workspace, cache, tmp } = instance
  const readWrite = [home, workspace, cache, tmp].join(' ')
  return [
    `AppArmorProfile=${instance.account}`,
    'NoNewPrivileges=yes',
    'CapabilityBoundingSet=',
    'ProtectSystem=strict',
    'ProtectHome=yes',
    `ReadWritePaths=${readWrite}`,
    `InaccessiblePaths=${config.paths.stateDir} ${config.paths.socketDir}`,
    'IPAddressDeny=any',
    'IPAddressAllow=localhost',
    `MemoryMax=${config.limits.memoryBytes}`,
    `TasksMax=${config.limits.pids}`,
    'RuntimeMaxSec=300',
  ]
}

/**
 * Exact `systemd-run` argv (after the executable) for the pre-start reconcile one-shot.
 * Order: wait/collect/pipe → slice → uid/gid → properties → setenv allowlist → node entry plan.
 */
export function buildReconcileSystemdRunArgv(input: ReconcileSystemdRunInput): string[] {
  const { instance, config, entryPath, planPath, npmGlobalConfig } = input
  const slice = unitSlice(instance)
  const pathValue = `${config.paths.toolchain}:/usr/bin:/usr/sbin`
  const setenv = [
    `--setenv=HOME=${instance.home}`,
    `--setenv=DSH_HOME=${instance.home}`,
    `--setenv=XDG_CACHE_HOME=${instance.cache}`,
    `--setenv=TMPDIR=${instance.tmp}`,
    `--setenv=PATH=${pathValue}`,
    `--setenv=NPM_CONFIG_GLOBALCONFIG=${npmGlobalConfig}`,
  ]
  const properties = renderReconcileUnitProperties(input).map((p) => `--property=${p}`)
  return [
    '--wait',
    '--collect',
    '--pipe',
    `--slice=${slice}`,
    `--uid=${instance.uid}`,
    `--gid=${instance.gid}`,
    ...properties,
    ...setenv,
    '--',
    config.tools.node,
    entryPath,
    planPath,
  ]
}

/** Resolve the per-account market npmrc path when `instanceMarketDir` is configured. */
export function instanceMarketNpmrcPath(config: SystemdConfig, account: string): string | undefined {
  const root = config.paths.instanceMarketDir
  if (root === undefined) return undefined
  return `${root}/${account}.npmrc`
}
