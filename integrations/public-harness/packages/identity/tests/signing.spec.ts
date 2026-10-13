/** Known-answer tests for cloud API signing, using the fixed example values published in the providers' documentation. */
import { describe, expect, it } from 'vitest'
import { signAcs3, signTc3 } from '../src/signing.ts'

describe('signatures', () => {
  it('acs3_matches_documented_example', () => {
    // Fixed-parameter example from https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature
    const result = signAcs3({ method: 'POST', canonicalUri: '/', query: { ImageId: 'win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd', RegionId: 'cn-shanghai' },
      headers: { host: 'ecs.cn-shanghai.aliyuncs.com', 'x-acs-action': 'RunInstances', 'x-acs-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'x-acs-date': '2023-10-26T10:22:32Z', 'x-acs-signature-nonce': '3156853299f313e23d1673dc12e1703d', 'x-acs-version': '2014-05-26' },
      body: '', accessKeyId: 'YourAccessKeyId', accessKeySecret: 'YourAccessKeySecret' })
    expect(result.stringToSign).toBe('ACS3-HMAC-SHA256\n7ea06492da5221eba5297e897ce16e55f964061054b7695beedaac1145b1e259')
    expect(result.signature).toBe('06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0')
    expect(result.authorization).toBe('ACS3-HMAC-SHA256 Credential=YourAccessKeyId,SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0')
  })

  it('tc3_matches_documented_example', () => {
    // DescribeInstances example from https://www.tencentcloud.com/document/product/1080/38766
    const result = signTc3({ service: 'cvm', host: 'cvm.tencentcloudapi.com', timestamp: 1551113065,
      payload: '{"Limit": 1, "Filters": [{"Values": ["\\u672a\\u547d\\u540d"], "Name": "instance-name"}]}',
      signedHeaders: { 'content-type': 'application/json; charset=utf-8', host: 'cvm.tencentcloudapi.com' }, secretId: 'example-secret-id', secretKey: 'Gu5t9xGARNpq86cd98joQYCN3EXAMPLE' })
    expect(result.hashedCanonicalRequest).toBe('5ffe6a04c0664d6b969fab9a13bdab201d63ee709638e2749d62a09ca18d7031')
    expect(result.stringToSign).toBe('TC3-HMAC-SHA256\n1551113065\n2019-02-25/cvm/tc3_request\n5ffe6a04c0664d6b969fab9a13bdab201d63ee709638e2749d62a09ca18d7031')
    expect(result.signature).toBe('72e494ea809ad7a8c8f7a4507b9bddcbaa8e581f516e8da2f66e2c5a96525168')
  })
})
