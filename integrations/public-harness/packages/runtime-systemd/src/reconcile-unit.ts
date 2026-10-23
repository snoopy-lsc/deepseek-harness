/**
 * Native pre-start reconcile transient unit (design § Fallback: pre-start reconcile).
 * Fixtures only on this box — P0.4 live systemd-run remains blocked.
 */
import type { RuntimeInstance } from '@public-harness/contracts'
import type { SystemdConfig } from './config.ts'
import { unitSlice } from './network.ts'

/** Env keys passed to pnpm via `--setenv` (exact allowlist; no root inherit, no model key). */
export const RECONCILE_UNIT_ENV_KEYS = [
  'HOME',
  'DSH_HOME',
  'XDG_CACHE_HOME',
  'TMPDIR',
  'PATH',
  'NPM_CONFIG_GLOBALCONFIG',
] as const

/**
 * Entry-only setenv keys (read by reconcile-entry-main; stripped from the pnpm env allowlist).
 * `DSH_MARKET_PORT` is the independent expected registry port; `DSH_HOST_ADDRESS` enables
 * hostAddress acceptance on the native path.
 */
export const RECONCILE_ENTRY_SETENV_KEYS = [
  'DSH_MARKET_PORT',
  'DSH_HOST_ADDRESS',
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
  /**
   * Absolute path of the plan JSON written by the provisioner.
   * Must be account-readable under the unit's ReadWritePaths (not under InaccessiblePaths
   * stateDir/controlDir) — prefer `reconcilePlanPath(home)`.
   */
  readonly planPath: string
  /** User's assigned `ports.market` port; passed independently of the plan registry URL. */
  readonly marketPort: number
  /** Optional pasta / container hostAddress accepted as registry host. */
  readonly hostAddress?: string
}

/**
 * Default plan path: `~/.dsh-market/reconcile-plan.json`.
 * Under the account home (ReadWritePaths), so the reconcile unit can read it despite
 * `InaccessiblePaths=<stateDir> <socketDir>` hiding `controlDir`.
 */
export function reconcilePlanPath(home: string): string {
  return `${home}/.dsh-market/reconcile-plan.json`
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
 * Order: wait/collect/pipe → slice → uid/gid → properties → setenv allowlist + entry
 * market port/hostAddress → node entry plan `--market-port`.
 */
export function buildReconcileSystemdRunArgv(input: ReconcileSystemdRunInput): string[] {
  const { instance, config, entryPath, planPath, npmGlobalConfig, marketPort, hostAddress } = input
  const slice = unitSlice(instance)
  const pathValue = `${config.paths.toolchain}:/usr/bin:/usr/sbin`
  const setenv = [
    `--setenv=HOME=${instance.home}`,
    `--setenv=DSH_HOME=${instance.home}`,
    `--setenv=XDG_CACHE_HOME=${instance.cache}`,
    `--setenv=TMPDIR=${instance.tmp}`,
    `--setenv=PATH=${pathValue}`,
    `--setenv=NPM_CONFIG_GLOBALCONFIG=${npmGlobalConfig}`,
    `--setenv=DSH_MARKET_PORT=${marketPort}`,
    ...(hostAddress !== undefined && hostAddress !== ''
      ? [`--setenv=DSH_HOST_ADDRESS=${hostAddress}`]
      : []),
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
    `--market-port=${marketPort}`,
  ]
}

/** Resolve the per-account market npmrc path when `instanceMarketDir` is configured. */
export function instanceMarketNpmrcPath(config: SystemdConfig, account: string): string | undefined {
  const root = config.paths.instanceMarketDir
  if (root === undefined) return undefined
  return `${root}/${account}.npmrc`
}
