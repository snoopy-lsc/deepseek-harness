/** Provider-neutral enterprise sign-in port; OIDC and WeCom implement it, DingTalk, SAML and LDAP follow. */

/** A verified enterprise identity. `subject` is stable per provider and is the only binding key; email is never used to find an account. */
export interface SsoIdentity {
  readonly subject: string
  readonly email: string
  readonly name: string
  /** Group and department values from the configured claims, used for the D7 allow-list. */
  readonly groups: readonly string[]
}

/** Browser-redirect sign-in. `begin` returns the IdP URL and per-attempt secrets the caller stores; `finish` verifies the callback. */
export interface SsoProvider {
  readonly kind: 'oidc' | 'wecom'
  /** Build the authorization redirect.
   * @param input Absolute callback URL registered at the IdP.
   * @returns The IdP URL and the state, nonce and PKCE verifier to store until the callback.
   */
  begin(input: { redirectUri: string }): Promise<{ url: string; secrets: { state: string; nonce: string; verifier: string } }>
  /** Exchange the code and verify the result.
   * @param input Callback code plus the stored nonce and verifier.
   * @returns The verified identity; throws `SsoRejectedError` for invalid input and `IdentityUnavailableError` when the IdP cannot be reached.
   */
  finish(input: { code: string; redirectUri: string; nonce: string; verifier: string }): Promise<SsoIdentity>
}

/** The IdP answered, but what it returned must not sign anyone in; the code is safe to show and to audit. */
export class SsoRejectedError extends Error {
  override readonly name = 'SsoRejectedError'
  constructor(readonly code: string) { super(`sso rejected: ${code}`) }
}
