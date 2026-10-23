/** Shared delivery and verification ports; implementations live in `mail.ts` and `captcha.ts`. Failures surface as unavailable, never as success. */
export type { CaptchaVerifier } from './captcha.ts'

/** One outgoing message. */
export interface Mail { readonly to: string; readonly subject: string; readonly text: string }
/** Delivery port; rejects when the message was not accepted. */
export type MailTransport = (mail: Mail) => Promise<void>

/** A dependency the request needs is down; the service answers 503 and admits nothing. */
export class IdentityUnavailableError extends Error {
  override readonly name = 'IdentityUnavailableError'
  constructor(readonly what: 'mail' | 'captcha' | 'store' | 'sso' | 'kb' | 'plugins') { super(`identity ${what} unavailable`) }
}
