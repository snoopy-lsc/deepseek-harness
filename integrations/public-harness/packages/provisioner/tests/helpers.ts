import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localGit, parseUserId, type GitRunner } from '@public-harness/contracts'
import type { AccountDirectory } from '../src/accounts.ts'
import type { ProvisionerConfig, ContainerRuntimeConfig } from '../src/config.ts'
import type { CommandResult, CommandRunner } from '../src/system.ts'
import { createFileStateStore, type StateStore } from '../src/state.ts'
import { createContainerInstanceRuntime, type ContainerInstanceRuntime } from '../src/runtime-provider.ts'
import { createUserProvisioner, type UserProvisioner } from '../src/users.ts'

export const uid = process.getuid!()
export const gid = process.getgid!()
export const alice = parseUserId('alice')
export const bob = parseUserId('bob')

export interface Call { command: string; args: string[] }

/** Records every command and answers from an optional handler; nothing is ever executed. */
export class FakeRunner implements CommandRunner {
  readonly calls: Call[] = []
  handler: (command: string, args: readonly string[]) => CommandResult | Promise<CommandResult | undefined> | undefined = () => undefined
  async run(command: string, args: readonly string[]): Promise<CommandResult> {
    this.calls.push({ command, args: [...args] })
    return (await this.handler(command, args)) ?? { code: 0, stdout: '', stderr: '' }
  }
}

/** In-memory account directory that reports the current process as owner of every account. */
export class FakeDirectory implements AccountDirectory {
  readonly accounts = new Map<string, { uid: number; gid: number; home: string; shell: string }>()
  readonly created: string[] = []
  readonly removed: string[] = []
  ownerOffset = 0
  async lookup(account: string) { return this.accounts.get(account) }
  async create(account: string, home: string): Promise<void> {
    this.created.push(account)
    this.accounts.set(account, { uid: uid + this.ownerOffset, gid, home, shell: '/usr/sbin/nologin' })
  }
  async remove(account: string): Promise<void> { this.removed.push(account); this.accounts.delete(account) }
}

export async function makeConfig(overrides: Partial<ProvisionerConfig> = {}): Promise<ProvisionerConfig & { runtime: ContainerRuntimeConfig }> {
  const base = await mkdtemp(join(tmpdir(), 'dsh-prov-'))
  const paths = { storageRoot: join(base, 'storage'), stateDir: join(base, 'state'), socketDir: join(base, 's'),
    runtimeAssets: join(base, 'assets'), quotaMount: join(base, 'mount') }
  for (const path of Object.values(paths)) await mkdir(path, { recursive: true, mode: 0o700 })
  const tool = (name: string): string => `/usr/bin/${name}`
  return {
    paths: { storageRoot: paths.storageRoot, stateDir: paths.stateDir, socketDir: paths.socketDir, quotaMount: paths.quotaMount },
    socketGid: gid, maxActiveInstances: 2, idleStopMs: 600_000, deletionRecoveryMs: 7 * 86_400_000,
    readyTimeoutMs: 5000, stopTimeoutMs: 5000, ports: { quota: { min: 29100, max: 29109 } },
    limits: { cpus: 1, memoryBytes: 1 << 30, pids: 512, openFiles: 4096, diskBytes: 5 * 2 ** 30 },
    tools: { getent: tool('getent'), useradd: tool('useradd'), userdel: tool('userdel'), nologin: '/usr/sbin/nologin' },
    ...overrides,
    runtime: { kind: 'podman-gvisor', runtimeAssets: paths.runtimeAssets, image: 'localhost/dsh-instance:1',
      hostAddress: '10.0.2.2', network: 'pasta', sidecar: { min: 29200, max: 29209 },
      tools: { loginctl: tool('loginctl'), sharedGroup: 'dsh-instances', setquota: '/usr/sbin/setquota', nft: '/usr/sbin/nft',
        runuser: '/usr/sbin/runuser', podman: tool('podman'), runsc: tool('runsc'), git: tool('git'), env: tool('env') } },
  }
}

export interface Harness {
  config: ProvisionerConfig
  directory: FakeDirectory
  runner: FakeRunner
  store: StateStore
  runtime: ContainerInstanceRuntime
  users: UserProvisioner
  clock: { now: number }
  failStorageOnce: { value: boolean }
}

export async function makeHarness(overrides: Partial<ProvisionerConfig> = {}): Promise<Harness> {
  const config = await makeConfig(overrides)
  const directory = new FakeDirectory()
  const runner = new FakeRunner()
  const store = createFileStateStore(config.paths.stateDir)
  const clock = { now: 1_000_000 }
  const failStorageOnce = { value: false }
  const gitFor = (): GitRunner => localGit
  let port = config.ports.quota.min
  const runtime = createContainerInstanceRuntime({ config, store, runner, publicHost: 'h.test', gitFor,
    probe: { controllers: async () => ['cpu', 'cpuset', 'hugetlb', 'io', 'memory', 'pids'] }, portFree: async () => true,
    quota: { healthy: async () => true, open: async () => ({ port: port++ }), issue: async () => ({ token: 'a.b', expiresAt: 1 }), close: async () => {} } })
  const users = createUserProvisioner({ config, store, directory, runner, runtime, clock: () => clock.now,
    ownership: { chown: async () => { if (failStorageOnce.value) { failStorageOnce.value = false; throw new Error('simulated power loss') } } } })
  return { config, directory, runner, store, users, runtime, clock, failStorageOnce }
}
