import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareAvatar } from '../src/client/profile.ts'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

function imageEnvironment(options: { broken?: boolean; encoded?: string } = {}) {
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local-image')
  class LocalImage {
    naturalWidth = 2048
    naturalHeight = 1024
    onload?: () => void
    onerror?: () => void
    set src(_value: string) { queueMicrotask(() => options.broken ? this.onerror?.() : this.onload?.()) }
  }
  const context = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() }
  const canvas = { width: 0, height: 0, getContext: () => context, toDataURL: vi.fn(() => options.encoded ?? 'data:image/jpeg;base64,aW1hZ2U=') }
  vi.stubGlobal('Image', LocalImage)
  vi.stubGlobal('document', { createElement: () => canvas })
  return { revoke, canvas, context }
}

describe('local avatar preparation', () => {
  it('rejects_unsupported_empty_and_oversized_files_before_decoding', async () => {
    for (const file of [new File(['x'], 'x.svg', { type: 'image/svg+xml' }), new File([], 'x.png', { type: 'image/png' }),
      new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'x.webp', { type: 'image/webp' })]) await expect(prepareAvatar(file)).rejects.toThrow('bad-avatar')
  })
  it('resizes_locally_and_releases_the_source_address_after_encoding', async () => {
    const { canvas, context, revoke } = imageEnvironment()
    expect(await prepareAvatar(new File(['image'], 'x.png', { type: 'image/png' }))).toEqual({ upload: { mime: 'image/jpeg', data: 'aW1hZ2U=' }, preview: 'data:image/jpeg;base64,aW1hZ2U=' })
    expect([canvas.width, canvas.height]).toEqual([512, 256])
    expect(context.drawImage).toHaveBeenCalledOnce()
    expect(canvas.toDataURL).toHaveBeenCalledWith('image/jpeg', 0.9)
    expect(revoke).toHaveBeenCalledWith('blob:local-image')
  })
  it('releases_failed_decodes_and_refuses_encoded_images_larger_than_the_server_limit', async () => {
    const broken = imageEnvironment({ broken: true })
    await expect(prepareAvatar(new File(['bad'], 'x.jpg', { type: 'image/jpeg' }))).rejects.toThrow('bad-avatar')
    expect(broken.revoke).toHaveBeenCalledWith('blob:local-image')
    vi.restoreAllMocks()
    const oversized = imageEnvironment({ encoded: `data:image/jpeg;base64,${'a'.repeat(700_000)}` })
    await expect(prepareAvatar(new File(['image'], 'x.webp', { type: 'image/webp' }))).rejects.toThrow('bad-avatar')
    expect(oversized.canvas.toDataURL).toHaveBeenCalledTimes(3)
    expect(oversized.revoke).toHaveBeenCalledWith('blob:local-image')
  })
})
