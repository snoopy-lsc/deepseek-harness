/** Cloud API request signing for the CAPTCHA providers; pure functions with documented known-answer tests. */
import { createHash, createHmac } from 'node:crypto'

const sha256Hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data, 'utf8').digest()

/** RFC 3986 encoding as Alibaba Cloud specifies it: unreserved characters kept, space as `%20`, `*` as `%2A`, `~` kept.
 * @param value Raw text.
 * @returns Encoded text.
 */
export function acsPercentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** Inputs of one Alibaba Cloud V3 (ACS3-HMAC-SHA256) signature. */
export interface Acs3Input {
  readonly method: string
  /** `/` for RPC-style APIs. */
  readonly canonicalUri: string
  readonly query: Readonly<Record<string, string>>
  /** Headers to send; every `x-acs-*`, `host` and `content-type` header is signed. */
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  readonly accessKeyId: string
  readonly accessKeySecret: string
}

/** Compute the Alibaba Cloud V3 signature.
 * Spec: https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature
 * @param input Request parts and credentials.
 * @returns The canonical request, string to sign, signature and Authorization header value.
 */
export function signAcs3(input: Acs3Input): { canonicalRequest: string; stringToSign: string; signature: string; authorization: string } {
  const query = Object.keys(input.query).sort().map(key => `${acsPercentEncode(key)}=${acsPercentEncode(input.query[key]!)}`).join('&')
  const headers = Object.entries(input.headers).map(([key, value]) => [key.toLowerCase(), value.trim()] as const)
    .filter(([key]) => key.startsWith('x-acs-') || key === 'host' || key === 'content-type').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  const signedHeaders = headers.map(([key]) => key).join(';')
  const canonicalRequest = [input.method.toUpperCase(), input.canonicalUri, query, headers.map(([key, value]) => `${key}:${value}\n`).join(''), signedHeaders, sha256Hex(input.body)].join('\n')
  const stringToSign = `ACS3-HMAC-SHA256\n${sha256Hex(canonicalRequest)}`
  const signature = hmac(input.accessKeySecret, stringToSign).toString('hex')
  return { canonicalRequest, stringToSign, signature, authorization: `ACS3-HMAC-SHA256 Credential=${input.accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}` }
}

/** Inputs of one Tencent Cloud API 3.0 (TC3-HMAC-SHA256) signature for a `POST /` JSON request. */
export interface Tc3Input {
  readonly service: string
  readonly host: string
  /** Seconds since the epoch; also the `X-TC-Timestamp` header. */
  readonly timestamp: number
  readonly payload: string
  /** Headers to sign (lowercase names), e.g. `content-type`, `host`, `x-tc-action`. */
  readonly signedHeaders: Readonly<Record<string, string>>
  readonly secretId: string
  readonly secretKey: string
}

/** Compute the Tencent Cloud TC3-HMAC-SHA256 signature.
 * Spec and the known-answer example values:
 * https://www.tencentcloud.com/document/product/1080/38766
 * @param input Request parts and credentials.
 * @returns The hashed canonical request, string to sign, signature and Authorization header value.
 */
export function signTc3(input: Tc3Input): { hashedCanonicalRequest: string; stringToSign: string; signature: string; authorization: string } {
  const headers = Object.entries(input.signedHeaders).map(([key, value]) => [key.toLowerCase(), value.trim().toLowerCase()] as const).sort(([a], [b]) => a < b ? -1 : 1)
  const signed = headers.map(([key]) => key).join(';')
  const canonicalRequest = ['POST', '/', '', headers.map(([key, value]) => `${key}:${value}\n`).join(''), signed, sha256Hex(input.payload)].join('\n')
  const date = new Date(input.timestamp * 1000).toISOString().slice(0, 10)
  const scope = `${date}/${input.service}/tc3_request`
  const hashedCanonicalRequest = sha256Hex(canonicalRequest)
  const stringToSign = `TC3-HMAC-SHA256\n${input.timestamp}\n${scope}\n${hashedCanonicalRequest}`
  const key = hmac(hmac(hmac(`TC3${input.secretKey}`, date), input.service), 'tc3_request')
  const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex')
  return { hashedCanonicalRequest, stringToSign, signature, authorization: `TC3-HMAC-SHA256 Credential=${input.secretId}/${scope}, SignedHeaders=${signed}, Signature=${signature}` }
}
