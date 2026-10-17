/** `/api/admin/groups*`: synced departments and groups with aliases, and administrator-managed local groups.
 * Membership changes re-authenticate (they can widen who reads a group-scoped knowledge base); every change is audited. */
import type { AdminModule } from './admin.ts'
import type { IdentityDatabase } from './database.ts'
import { MeError } from './me.ts'
import { IdentityUnavailableError } from './transports.ts'

export const GROUP_ADMIN_ENDPOINTS = { GET: ['/groups', '/groups/members'], POST: ['/groups', '/groups/members'] } as const

const NAME = (value: unknown): string => {
  if (typeof value !== 'string') throw new MeError(400, 'body')
  const name = value.trim()
  if (name.length === 0 || name.length > 120 || /[\0-\x1f\x7f]/.test(name)) throw new MeError(400, 'body')
  return name
}
const ID = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 600) throw new MeError(400, 'body')
  return value
}

/** Build the groups route module.
 * @param database Identity database.
 * @param clock Millisecond clock.
 * @returns Module.
 */
export function groupAdminRoutes(database: IdentityDatabase, clock: () => number): AdminModule {
  const groups = database.groups
  const store = <T>(work: () => T): T => { try { return work() } catch (error) { if (error instanceof MeError) throw error; throw new IdentityUnavailableError('store') } }
  const emails = database.db.prepare('SELECT id, email, name FROM user WHERE id = ?')
  return async ctx => {
    if (ctx.sub !== '/groups' && ctx.sub !== '/groups/members') return false
    if (ctx.verb === 'GET') {
      if (ctx.sub === '/groups') { ctx.send(200, { groups: store(() => groups.list()) }); return true }
      const id = ID(ctx.query.get('group'))
      const group = store(() => groups.get(id))
      if (group === undefined) throw new MeError(404, 'group-not-found')
      const members = store(() => groups.membersOf(id).map(userId => {
        const row = emails.get(userId) as { id: string; email: string; name: string } | undefined
        return { userId, email: row?.email.toLowerCase() ?? null, name: row?.name ?? null }
      }))
      ctx.send(200, { group, members }); return true
    }
    const body = await ctx.json()
    if (ctx.sub === '/groups') {
      const op = body.op
      if (op === 'create') {
        const group = store(() => groups.createLocal(NAME(body.name), clock()))
        ctx.audit('admin-group-change', 'ok', undefined, `op=create group=${group.id}`)
        ctx.send(200, { group }); return true
      }
      const id = ID(body.id)
      const group = store(() => groups.get(id))
      if (group === undefined) throw new MeError(404, 'group-not-found')
      if (op === 'rename' || op === 'alias') {
        // Local groups are renamed; synced ones get an alias (null clears it). The name is display only, never an authorization input.
        const name = op === 'alias' && body.name === null ? null : NAME(body.name)
        if (op === 'rename' && group.source !== 'local') throw new MeError(409, 'not-local')
        if (op === 'alias' && group.source === 'local') throw new MeError(409, 'local')
        store(() => groups.setDisplayName(id, name, clock()))
        ctx.audit('admin-group-change', 'ok', undefined, `op=${op} group=${id}`)
        ctx.send(200, { group: store(() => groups.get(id)) }); return true
      }
      if (op === 'delete') {
        if (group.source !== 'local') throw new MeError(409, 'not-local')
        await ctx.reauth(body, 'group')
        store(() => groups.deleteLocal(id))
        ctx.audit('admin-group-change', 'ok', undefined, `op=delete group=${id} members=${group.members}`)
        ctx.send(200, { deleted: true }); return true
      }
      throw new MeError(400, 'body')
    }
    const op = body.op
    if (op !== 'add' && op !== 'remove') throw new MeError(400, 'body')
    const id = ID(body.groupId)
    const group = store(() => groups.get(id))
    if (group === undefined) throw new MeError(404, 'group-not-found')
    if (group.source !== 'local') throw new MeError(409, 'not-local')
    const user = ctx.target(body)
    await ctx.reauth(body, 'group')
    const changed = store(() => op === 'add' ? groups.addLocalMember(id, user.id, clock()) : groups.removeLocalMember(id, user.id))
    if (changed) ctx.audit('admin-group-change', 'ok', user, `op=member-${op} group=${id}`)
    ctx.send(200, { changed, group: store(() => groups.get(id)) }); return true
  }
}
