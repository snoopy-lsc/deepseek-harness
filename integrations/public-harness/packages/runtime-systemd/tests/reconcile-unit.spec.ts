/** 1D.6: native reconcile unit-text / env fixtures (P0.4 — no live systemd-run). */
import { describe, expect, it } from 'vitest'
import {
  RECONCILE_ENV_ALLOWLIST,
  buildReconcileEnv,
} from '../../plugins/src/reconcile-entry.ts'
import {
  buildReconcileSystemdRunArgv,
  renderReconcileUnitProperties,
} from '../src/reconcile-unit.ts'
import { config, instance } from './fixture.ts'

describe('reconcile unit text fixtures (P0.4 substitute; live systemd blocked)', () => {
  it('renderReconcileUnitProperties_matches_initializeWorkspace_shape_plus_loopback', () => {
    const i = instance()
    const cfg = config()
    const props = renderReconcileUnitProperties({
      instance: i,
      config: cfg,
      npmGlobalConfig: '/run/dsh-public/instance-market/acct.npmrc',
    })
    expect(props).toContain(`AppArmorProfile=${i.account}`)
    expect(props).toContain('NoNewPrivileges=yes')
    expect(props).toContain('CapabilityBoundingSet=')
    expect(props).toContain('ProtectSystem=strict')
    expect(props).toContain('ProtectHome=yes')
    expect(props).toContain('IPAddressDeny=any')
    expect(props).toContain('IPAddressAllow=localhost')
    expect(props).toContain('RuntimeMaxSec=300')
    expect(props).toContain(`MemoryMax=${cfg.limits.memoryBytes}`)
    expect(props).toContain(`TasksMax=${cfg.limits.pids}`)
    expect(props.some((p) => p.startsWith('ReadWritePaths=') && p.includes(i.home))).toBe(true)
    expect(props.some((p) => p.startsWith('InaccessiblePaths=') && p.includes(cfg.paths.stateDir))).toBe(true)
    // Must NOT use PrivateNetwork — needs loopback market port.
    expect(props.join('\n')).not.toContain('PrivateNetwork=yes')
  })

  it('buildReconcileSystemdRunArgv_orders_slice_uid_gid_setenv_and_entry', () => {
    const i = instance()
    const cfg = config()
    const argv = buildReconcileSystemdRunArgv({
      instance: i,
      config: cfg,
      entryPath: '/opt/dsh/release/reconcile-entry.mjs',
      planPath: `${i.controlDir}/reconcile-plan.json`,
      npmGlobalConfig: '/run/dsh-public/instance-market/acct.npmrc',
    })
    expect(argv[0]).toBe('--wait')
    expect(argv).toContain('--collect')
    expect(argv).toContain('--pipe')
    expect(argv.some((a) => a.startsWith('--slice=') && a.includes('dsh-user'))).toBe(true)
    expect(argv).toContain(`--uid=${i.uid}`)
    expect(argv).toContain(`--gid=${i.gid}`)
    expect(argv).toContain('--property=IPAddressDeny=any')
    expect(argv).toContain('--property=IPAddressAllow=localhost')
    expect(argv).toContain('--property=RuntimeMaxSec=300')
    expect(argv).toContain(`--setenv=HOME=${i.home}`)
    expect(argv).toContain(`--setenv=DSH_HOME=${i.home}`)
    expect(argv).toContain(`--setenv=XDG_CACHE_HOME=${i.cache}`)
    expect(argv).toContain(`--setenv=TMPDIR=${i.tmp}`)
    expect(argv.some((a) => a.startsWith('--setenv=PATH=') && a.includes(cfg.paths.toolchain))).toBe(true)
    expect(argv).toContain('--setenv=NPM_CONFIG_GLOBALCONFIG=/run/dsh-public/instance-market/acct.npmrc')
    // Env allowlist only — no model key setenv.
    expect(argv.join('\n')).not.toContain('DSH_MODEL_API_KEY')
    const sep = argv.indexOf('--')
    expect(sep).toBeGreaterThan(0)
    expect(argv.slice(sep + 1)).toEqual([
      cfg.tools.node,
      '/opt/dsh/release/reconcile-entry.mjs',
      `${i.controlDir}/reconcile-plan.json`,
    ])
  })

  it('reconcile_env_allowlist_matches_plugins_helper', () => {
    expect(RECONCILE_ENV_ALLOWLIST).toEqual([
      'HOME', 'DSH_HOME', 'XDG_CACHE_HOME', 'TMPDIR', 'PATH', 'NPM_CONFIG_GLOBALCONFIG',
    ])
    const env = buildReconcileEnv({
      home: '/h', dshHome: '/h', cacheHome: '/c', tmpdir: '/t',
      path: '/opt/dsh/toolchain:/usr/bin', npmGlobalConfig: '/g.npmrc',
    })
    expect(Object.keys(env).sort()).toEqual([...RECONCILE_ENV_ALLOWLIST].sort())
  })
})
