/** Provider-neutral enterprise sign-in port; OIDC, WeCom, DingTalk and SAML implement the redirect port; LDAP the password port. */

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
  readonly kind: 'oidc' | 'wecom' | 'dingtalk' | 'saml'
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
  /** Service-provider metadata to publish, for providers that have it (SAML). */
  metadata?(): string
  /** Directory reconciliation, for providers with a directory API (WeCom, DingTalk). */
  readonly directory?: DirectoryLookup
}

/** What the directory says about one bound subject during reconciliation. `missing` is a definitive "no such user" answer, never an error. */
export type DirectoryRecord = { readonly status: 'active'; readonly groups: readonly string[] } | { readonly status: 'disabled' } | { readonly status: 'missing' }

/** Directory read used by deprovisioning; providers without a directory API (OIDC, SAML) do not have it. */
export interface DirectoryLookup {
  /** Look up one subject.
   * @param subject Stored subject.
   * @returns The record, or undefined when the subject belongs to another directory; throws `IdentityUnavailableError` on any error, which never disables anyone.
   */
  lookup(subject: string): Promise<DirectoryRecord | undefined>
}

/** The IdP answered, but what it returned must not sign anyone in; the code is safe to show and to audit. */
export class SsoRejectedError extends Error {
  override readonly name = 'SsoRejectedError'
  constructor(readonly code: string) { super(`sso rejected: ${code}`) }
}

/** Username/password enterprise sign-in (LDAP, Active Directory); the service checks the password against the directory. */
export interface PasswordSsoProvider {
  readonly kind: 'ldap'
  /** Verify the credentials.
   * @param input Username and password as typed.
   * @returns The verified identity; throws `SsoRejectedError` (one code for every credential failure) or `IdentityUnavailableError`.
   */
  authenticate(input: { username: string; password: string }): Promise<SsoIdentity>
  /** Directory reconciliation by immutable ID. */
  readonly directory?: DirectoryLookup
}
