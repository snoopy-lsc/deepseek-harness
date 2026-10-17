/** Production knowledge base profile: strict configuration and native account trees (derived account, getent ids, never root). */
import { describe, expect, it } from 'vitest'
import { deriveNames } from '@public-harness/provisioner/accounts'
import { parseUserId } from '@public-harness/contracts'
import { nativeUserTrees, parseKbProfileConfig } from '../src/kb-service.ts'

const base = { socket: '/run/dsh-public/kb.sock', root: '/srv/dsh-public/kb', storageRoot: '/srv/dsh-public', systemdRun: '/usr/bin/systemd-run', node: '/opt/dsh/node/bin/node',
  getent: '/usr/bin/getent', inaccessible: ['/srv/dsh-public/kb'] }

describe('kb profile', () => {
  it('parses_strictly_and_requires_the_kb_root_to_be_hidden_from_helpers', () => {
    expect(parseKbProfileConfig({ ...base, socketGid: 990, compile: { quotaSocket: '/run/dsh-public/quota.sock', modelId: 'deepseek-chat', siteWorkers: 2 } }))
      .toMatchObject({ socketGid: 990, compile: { quotaSocket: '/run/dsh-public/quota.sock', modelId: 'deepseek-chat', siteWorkers: 2 } })
    expect(() => parseKbProfileConfig({ ...base, inaccessible: ['/srv/other'] })).toThrow(/KB root/)
    expect(() => parseKbProfileConfig({ ...base, extra: 1 })).toThrow()
    expect(() => parseKbProfileConfig({ ...base, root: 'relative' })).toThrow()
    expect(() => parseKbProfileConfig({ ...base, compile: { quotaSocket: '/q.sock', modelId: 'bad model' } })).toThrow(/modelId/)
    expect(() => parseKbProfileConfig({ ...base, compile: { quotaSocket: '/q.sock', modelId: 'm', siteWorkers: 0 } })).toThrow(/siteWorkers/)
  })
  it('maps_users_to_their_derived_native_account_and_refuses_root_or_missing_accounts', async () => {
    const userId = 'user_0123456789abcdef'
    const account = deriveNames(parseUserId(userId)).account
    const ids = new Map([[account, { uid: 61234, gid: 61234 }]])
    const trees = nativeUserTrees(base, async name => ids.get(name))
    expect(await trees(userId)).toEqual({ userId, account, kbDir: `/srv/dsh-public/users/${account}/kb`, uid: 61234, gid: 61234 })
    expect(await trees('user_missing0000000000')).toBeUndefined()
    expect(await trees('../etc')).toBeUndefined()
    ids.set(account, { uid: 0, gid: 0 })
    expect(await trees(userId)).toBeUndefined()
  })
})
