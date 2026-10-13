/** LDAP and Active Directory username/password sign-in: one connection per login, LDAPS or StartTLS, service bind, search, then the user's own bind.
 * References: RFC 4511 (protocol), RFC 4513 (authentication methods; unauthenticated bind §5.1.2, StartTLS §3), RFC 4514 (DN strings),
 * RFC 4515 (search filters), RFC 4530 (entryUUID); Microsoft docs on objectGUID, userAccountControl and LDAP_MATCHING_RULE_IN_CHAIN:
 * https://learn.microsoft.com/en-us/windows/win32/adschema/a-objectguid, https://learn.microsoft.com/en-us/troubleshoot/windows-server/active-directory/useraccountcontrol-manipulate-account-properties,
 * https://learn.microsoft.com/en-us/windows/win32/adsi/search-filter-syntax. Client: ldapts https://github.com/ldapts/ldapts. */
import { createHash } from 'node:crypto'
import { Client, InvalidCredentialsError, type Entry } from 'ldapts'
import { IdentityUnavailableError } from '../transports.ts'
import { normalizeDn, type SsoConfig } from './config.ts'
import { SsoRejectedError, type PasswordSsoProvider, type SsoIdentity } from './provider.ts'

type LdapConfig = Extract<SsoConfig, { kind: 'ldap' }>

const IN_CHAIN = '1.2.840.113556.1.4.1941'
/** userAccountControl ACCOUNTDISABLE. */
const ACCOUNTDISABLE = 0x2
const EMAIL = /^[^\s<>@]{1,64}@[^\s<>@]{1,255}$/

/** Escape an assertion value for an LDAP search filter (RFC 4515 §3): `*`, `(`, `)`, `\`, NUL and other control bytes become `\XX`.
 * @param value Untrusted text.
 * @returns Escaped value.
 */
export function escapeFilterValue(value: string): string {
  return value.replace(/[*()\\\u0000-\u001f\u007f]/g, ch => `\\${ch.charCodeAt(0).toString(16).padStart(2, '0')}`)
}

/** Escape an attribute value for a DN string (RFC 4514 §2.4).
 * @param value Untrusted text.
 * @returns Escaped value.
 */
export function escapeDnValue(value: string): string {
  let out = value.replace(/[\\",+;<>]/g, ch => `\\${ch}`).replace(/\u0000/g, '\\00')
  if (/^[ #]/.test(out)) out = `\\${out}`
  if (/ $/.test(out) && out.length > 1) out = `${out.slice(0, -1)}\\ `
  return out
}

/** Render a 16-byte objectGUID in the Windows string form (first three groups little-endian).
 * @param bytes Raw attribute value.
 * @returns Lower-case GUID string.
 */
export function formatObjectGuid(bytes: Buffer): string {
  const hex = (start: number, end: number, reverse = false) => { const part = [...bytes.subarray(start, end)]; return (reverse ? part.reverse() : part).map(b => b.toString(16).padStart(2, '0')).join('') }
  return `${hex(0, 4, true)}-${hex(4, 6, true)}-${hex(6, 8, true)}-${hex(8, 10)}-${hex(10, 16)}`
}

/** Stand-in address when the directory has no usable email; same rule as the other providers.
 * @param subject Server-scoped subject.
 * @returns Placeholder address.
 */
export function ldapPlaceholderEmail(subject: string): string {
  return `ldap-${createHash('sha256').update(`ldap\0${subject}`).digest('hex').slice(0, 32)}@sso.invalid`
}

/** Create the LDAP provider.
 * @param config LDAP settings from `DSH_LDAP_*`.
 * @returns Provider; bad credentials raise `SsoRejectedError('credentials')` whatever the cause, outages `IdentityUnavailableError`.
 */
export function createLdapProvider(config: LdapConfig): PasswordSsoProvider {
  const tlsOptions = { minVersion: 'TLSv1.2' as const, ...config.ca === undefined ? {} : { ca: [config.ca] } }
  const first = (entry: Entry, name: string) => {
    const value = Object.entries(entry).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
    return Array.isArray(value) ? value[0] : value
  }
  const all = (entry: Entry, name: string) => {
    const value = Object.entries(entry).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
    return (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(item => Buffer.isBuffer(item) ? item.toString('utf8') : String(item))
  }
  return {
    kind: 'ldap',
    async authenticate({ username, password }): Promise<SsoIdentity> {
      // RFC 4513 §5.1.2: a simple bind with an empty password is an unauthenticated bind that servers accept, so it is refused here.
      const name = username.trim()
      if (!password || password.length > 1024 || !name || name.length > 256 || /[\u0000-\u001f\u007f]/.test(name)) throw new SsoRejectedError('credentials')
      // One connection per login: no pooled session can ever carry a user's bind into another login.
      // ldapts opens implicit TLS whenever `tlsOptions` is set, so ldap:// with StartTLS must not pass them here.
      const client = new Client({ url: config.url, timeout: config.timeoutMs, connectTimeout: config.timeoutMs, ...config.startTls ? {} : { tlsOptions }, strictDN: true })
      try {
        // The upgraded socket has no host of its own; without it Node would check the certificate against `localhost`.
        if (config.startTls) await client.startTLS({ ...tlsOptions, host: new URL(config.url).hostname.replace(/^\[|\]$/g, '') })
        try { await client.bind(config.bindDn, config.bindPassword) } catch { throw new IdentityUnavailableError('sso') }
        const filter = `(&${config.userFilter}(${config.usernameAttribute}=${escapeFilterValue(name)}))`
        const attributes = [config.idAttribute, config.emailAttribute, config.nameAttribute, 'memberOf', ...config.activeDirectory ? ['userAccountControl'] : []]
        let entries: Entry[]
        try {
          ({ searchEntries: entries } = await client.search(config.baseDn, { scope: 'sub', filter, sizeLimit: 2, attributes, explicitBufferAttributes: ['objectGUID'] }))
        } catch (error) {
          if ((error as { code?: number }).code === 4) throw new SsoRejectedError('credentials')
          throw error
        }
        // Zero or several matches look exactly like a wrong password.
        if (entries.length !== 1) throw new SsoRejectedError('credentials')
        const entry = entries[0]!
        let groups: string[]
        if (config.groupMode === 'memberOf') groups = all(entry, 'memberOf')
        else {
          const value = escapeFilterValue(entry.dn)
          const groupFilter = config.groupMode === 'nested' ? `(member:${IN_CHAIN}:=${value})` : `(&(objectClass=${escapeFilterValue(config.groupObjectClass)})(member=${value}))`
          groups = (await client.search(config.groupBaseDn, { scope: 'sub', filter: groupFilter, attributes: ['1.1'] })).searchEntries.map(group => group.dn)
        }
        // The user's own bind comes last, after every service search on this connection.
        try { await client.bind(entry.dn, password) } catch (error) {
          if (error instanceof InvalidCredentialsError) throw new SsoRejectedError('credentials')
          throw error
        }
        if (config.activeDirectory && (Number(first(entry, 'userAccountControl')) & ACCOUNTDISABLE)) throw new SsoRejectedError('inactive')
        const raw = first(entry, config.idAttribute)
        const id = Buffer.isBuffer(raw) ? (raw.length === 16 && config.idAttribute.toLowerCase() === 'objectguid' ? formatObjectGuid(raw) : raw.toString('hex')) : typeof raw === 'string' ? raw.trim().toLowerCase() : ''
        // A directory without the immutable ID attribute cannot be bound safely; refuse instead of falling back to the username.
        if (!id || id.length > 256) throw new IdentityUnavailableError('sso')
        const subject = `${config.serverId}|${id}`
        const mail = all(entry, config.emailAttribute).map(value => value.trim()).find(value => EMAIL.test(value))
        const display = all(entry, config.nameAttribute).map(value => value.trim()).find(Boolean) ?? name
        return { subject, email: mail?.toLowerCase() ?? ldapPlaceholderEmail(subject), name: display.slice(0, 128), groups: [...new Set(groups.map(normalizeDn))] }
      } catch (error) {
        if (error instanceof SsoRejectedError || error instanceof IdentityUnavailableError) throw error
        // TLS failures, timeouts, refused connections and protocol errors: fail closed.
        throw new IdentityUnavailableError('sso')
      } finally {
        await client.unbind().catch(() => undefined)
      }
    },
  }
}
