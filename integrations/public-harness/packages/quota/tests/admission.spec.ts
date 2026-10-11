import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { parseUserId } from '../../contracts/src/index.ts'
import { createTokenIssuer } from '../src/tokens.ts'
import { createAdmission, type AdmissionConfig } from '../src/admission.ts'
import type { QuotaLedger, Reservation, ReservationId } from '../src/ledger.ts'

const alice = parseUserId('alice')
const secret = randomBytes(32)
const clock = () => new Date('2026-10-11T10:00:00.000Z')
const body = (values: object = {}) => Buffer.from(JSON.stringify({ model: 'deepseek-test', max_tokens: 10, messages: [], ...values }))
const config: AdmissionConfig = {
  modelContextWindows: { 'deepseek-test': 100 },
  maxBodyBytes: 4096, maxImagesPerRequest: 2, maxInlineImageBytes: 1024,
}

function setup() {
  const issuer = createTokenIssuer({ secret, issuer: 'test-dev', lifetimeMs: 60_000, clock })
  const reservations: { userId: string; maximumTokens: number }[] = []
  const ledger: QuotaLedger = {
    async reserve(userId, maximumTokens) {
      reservations.push({ userId, maximumTokens })
      return { id: 'reservation' as ReservationId, userId, day: '2026-10-11', maximumTokens } satisfies Reservation
    },
    async settle() {}, close() {},
  }
  const admission = createAdmission({ config, issuer, ledger })
  const token = issuer.issue(alice, 'instance-a').token
  const request = (overrides: object = {}) => ({
    method: 'POST', path: '/v1/messages', instanceId: 'instance-a', authorization: `Bearer ${token}`,
    contentType: 'application/json', body: body(), ...overrides,
  })
  return { issuer, admission, request, reservations }
}

describe('model request admission', () => {
  it('reserves the known context window plus requested output before forwarding', async () => {
    const { admission, request, reservations } = setup()
    const admitted = await admission.admit(request())
    expect(admitted.userId).toBe(alice)
    expect(reservations).toEqual([{ userId: alice, maximumTokens: 110 }])
  })

  it('rejects expired and cross-instance credentials', async () => {
    const { admission, request, issuer, reservations } = setup()
    await expect(admission.admit(request({ instanceId: 'instance-b' }))).rejects.toThrow(/instance/i)
    const expiredIssuer = createTokenIssuer({ secret, issuer: 'test-dev', lifetimeMs: 60_000,
      clock: () => new Date(clock().valueOf() + 61_000) })
    expect(() => expiredIssuer.verify(issuer.issue(alice, 'instance-a').token, 'instance-a')).toThrow(/expired/i)
    expect(reservations).toEqual([])
  })

  it('rejects a wrong issuer or signature before reservation', async () => {
    const { admission, request, reservations } = setup()
    const other = createTokenIssuer({ secret, issuer: 'production', lifetimeMs: 60_000, clock })
    await expect(admission.admit(request({ authorization: `Bearer ${other.issue(alice, 'instance-a').token}` }))).rejects.toThrow(/issuer/i)
    const forged = request()
    await expect(admission.admit(request({ authorization: `${forged.authorization}forged` }))).rejects.toThrow(/signature/i)
    expect(reservations).toEqual([])
  })

  it('rejects unsupported routes, methods, and malformed bodies', async () => {
    const { admission, request, reservations } = setup()
    await expect(admission.admit(request({ path: '/v1/chat/completions' }))).rejects.toThrow(/path/i)
    await expect(admission.admit(request({ method: 'GET' }))).rejects.toThrow(/method/i)
    await expect(admission.admit(request({ contentType: 'text/plain' }))).rejects.toThrow(/content type/i)
    await expect(admission.admit(request({ body: Buffer.from('{') }))).rejects.toThrow(/JSON/i)
    expect(reservations).toEqual([])
  })

  it('rejects oversized bodies and images before reservation', async () => {
    const { admission, request, reservations } = setup()
    await expect(admission.admit(request({ body: Buffer.alloc(4097) }))).rejects.toThrow(/body/i)
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a'.repeat(1500) } }
    await expect(admission.admit(request({ body: body({ messages: [{ role: 'user', content: [image] }] }) }))).rejects.toThrow(/image/i)
    const small = { ...image, source: { ...image.source, data: 'a' } }
    await expect(admission.admit(request({ body: body({ messages: [{ role: 'user', content: [small, small, small] }] }) }))).rejects.toThrow(/image/i)
    expect(reservations).toEqual([])
  })

  it('rejects missing output bounds and unknown or unbounded models', async () => {
    const { admission, request, reservations } = setup()
    await expect(admission.admit(request({ body: body({ max_tokens: undefined }) }))).rejects.toThrow(/max_tokens/i)
    await expect(admission.admit(request({ body: body({ model: 'other' }) }))).rejects.toThrow(/model/i)
    expect(() => createAdmission({ config: { ...config, modelContextWindows: { other: 0 } },
      issuer: createTokenIssuer({ secret, issuer: 'test-dev', lifetimeMs: 60_000, clock }),
      ledger: { reserve: vi.fn(), settle: vi.fn(), close: vi.fn() } })).toThrow(/context/i)
    expect(reservations).toEqual([])
  })

  it('accepts only file-referenced images owned by the token user', async () => {
    const { issuer, request, reservations } = setup()
    const owned = vi.fn((userId, fileId) => userId === alice && fileId === 'file_owned')
    const ledger: QuotaLedger = { async reserve(userId, maximumTokens) {
      reservations.push({ userId, maximumTokens })
      return { id: 'file-reservation' as ReservationId, userId, day: '2026-10-11', maximumTokens }
    }, async settle() {}, close() {} }
    const admission = createAdmission({ config, issuer, ledger, ownsFile: owned })
    const image = (fileId: string) => body({ messages: [{ role: 'user', content: [{
      type: 'image', source: { type: 'file', file_id: fileId },
    }] }] })
    await expect(admission.admit(request({ body: image('file_forged') }))).rejects.toThrow(/ownership/i)
    expect(reservations).toEqual([])
    await admission.admit(request({ body: image('file_owned') }))
    expect(owned).toHaveBeenCalledWith(alice, 'file_owned')
    expect(reservations).toHaveLength(1)
  })
})
