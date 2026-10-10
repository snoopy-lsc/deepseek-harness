import { describe, expect, it } from 'vitest'
import { createReadyMessage } from '../src/index.ts'

describe('Web launch-token publisher', () => {
  it('sends only the token and bound port through IPC', () => {
    const message = createReadyMessage({
      authenticatedUrl: base => `${base}/?token=private-token`,
    }, 4123)
    expect(message).toEqual({ kind: 'public-harness/web-ready', port: 4123, token: 'private-token' })
    expect(JSON.stringify(message)).not.toContain('http://')
  })

  it('refuses a malformed authenticated URL', () => {
    expect(() => createReadyMessage({ authenticatedUrl: () => 'https://other.example/?token=x' }, 4123)).toThrow()
  })
})
