/** Profile field validation and image preparation shared by the profile forms. */
import type { AdminProfilePatch, AvatarUpload, UserProfile } from './me.ts'
import type { ProfileCopyKey } from './profile-copy.ts'

/** Trim and select only fields editable in this form.
 * @param draft - Current form values.
 * @param admin - Whether organization fields can be edited.
 * @returns The allowed profile update.
 */
export function profilePatch(draft: UserProfile, admin: boolean): AdminProfilePatch {
  return { ...draft.managedBy === 'local' ? { name: draft.name.trim() } : {}, phone: draft.phone.trim(),
    ...admin ? { employeeId: draft.employeeId.trim(), department: draft.department.trim(), jobTitle: draft.jobTitle.trim() } : {} }
}

/** Validate only editable fields against the server limits.
 * @param draft - Current form values.
 * @param admin - Whether organization fields can be edited.
 * @returns A localized error key, or undefined when valid.
 */
export function profileValidation(draft: UserProfile, admin: boolean): ProfileCopyKey | undefined {
  if (draft.managedBy === 'local' && (draft.name.trim().length < 1 || draft.name.trim().length > 100)) return 'profileInvalidName'
  if (draft.phone.trim().length > 40) return 'profileInvalidPhone'
  if (admin) {
    if (draft.employeeId.trim().length > 64) return 'profileInvalidEmployeeId'
    if (draft.department.trim().length > 100) return 'profileInvalidDepartment'
    if (draft.jobTitle.trim().length > 100) return 'profileInvalidJobTitle'
  }
  return undefined
}

/** Accept only the authenticated avatar route, never remote or inline addresses.
 * @param url - Avatar address returned by the server.
 * @returns A safe avatar address, if present.
 */
export function avatarSource(url: string | null): string | undefined {
  return url !== null && /^\/account\/api\/me\/avatar(?:\?[^#]*)?$/.test(url) ? url : undefined
}

/** Resize a local image to a 512px edge and encode no more than 512 KiB.
 * @param file - PNG, JPEG or WebP image, no larger than 5 MiB.
 * @returns The server upload and a local preview address.
 * @throws When the image is unsupported, unreadable, or cannot fit the upload limit.
 */
export async function prepareAvatar(file: File): Promise<{ upload: AvatarUpload; preview: string }> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024 || file.size === 0) throw new Error('bad-avatar')
  const objectUrl = URL.createObjectURL(file)
  const image = new Image()
  try {
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('bad-avatar')); image.src = objectUrl })
    if (image.naturalWidth < 1 || image.naturalHeight < 1) throw new Error('bad-avatar')
    const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('bad-avatar')
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    for (const quality of [0.9, 0.75, 0.6]) {
      const preview = canvas.toDataURL('image/jpeg', quality)
      const data = preview.slice(preview.indexOf(',') + 1)
      if (preview.startsWith('data:image/jpeg;base64,') && Math.ceil(data.length * 3 / 4) <= 512 * 1024) return { upload: { mime: 'image/jpeg', data }, preview }
    }
    throw new Error('bad-avatar')
  } finally { URL.revokeObjectURL(objectUrl) }
}
