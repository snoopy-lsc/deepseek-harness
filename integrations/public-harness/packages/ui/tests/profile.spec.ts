import { describe, expect, it } from 'vitest'
import { profilePatch, profileValidation, avatarSource } from '../src/client/profile.ts'
import { profileCopy } from '../src/client/profile-copy.ts'

const local = { name: 'Ann', email: 'ann@example.test', phone: '', employeeId: '', department: '', jobTitle: '', avatarUrl: null, managedBy: 'local' as const }
describe('profile editing', () => {
  it('own_updates_include_only_contact_fields_and_sso_names_are_omitted', () => {
    const draft = { ...local, name: ' Ann B ', phone: ' +86 123 ', employeeId: '42', department: 'Product', jobTitle: 'Lead' }
    expect(profilePatch(draft, false)).toEqual({ name: 'Ann B', phone: '+86 123' })
    expect(profilePatch({ ...draft, managedBy: 'sso' }, false)).toEqual({ phone: '+86 123' })
    expect(profilePatch(draft, true)).toEqual({ name: 'Ann B', phone: '+86 123', employeeId: '42', department: 'Product', jobTitle: 'Lead' })
  })
  it('validates_trimmed_field_limits_and_only_editable_fields', () => {
    expect(profileValidation({ ...local, name: ' ' }, false)).toBe('profileInvalidName')
    expect(profileValidation({ ...local, name: 'x'.repeat(101) }, true)).toBe('profileInvalidName')
    expect(profileValidation({ ...local, phone: '1'.repeat(41) }, false)).toBe('profileInvalidPhone')
    expect(profileValidation({ ...local, employeeId: '1'.repeat(65) }, true)).toBe('profileInvalidEmployeeId')
    expect(profileValidation({ ...local, department: 'a'.repeat(101) }, true)).toBe('profileInvalidDepartment')
    expect(profileValidation({ ...local, jobTitle: 'a'.repeat(101) }, true)).toBe('profileInvalidJobTitle')
    expect(profileValidation({ ...local, name: '', managedBy: 'sso', department: 'a'.repeat(101) }, false)).toBeUndefined()
  })
  it('avatars_only_use_the_authenticated_account_endpoint', () => {
    expect(avatarSource('/account/api/me/avatar?userId=a&v=abc')).toBe('/account/api/me/avatar?userId=a&v=abc')
    for (const url of ['https://remote.test/avatar', '//remote.test/avatar', 'data:image/png;base64,x', '/account/api/me/avatar/other', '/account/api/me/avatar#x']) expect(avatarSource(url)).toBeUndefined()
    expect(avatarSource(null)).toBeUndefined()
  })
  it('every_profile_label_and_validation_message_has_both_locales', () => {
    expect(Object.keys(profileCopy.en).sort()).toEqual(Object.keys(profileCopy.zh).sort())
    for (const copy of Object.values(profileCopy)) for (const text of Object.values(copy)) expect(text.length).toBeGreaterThan(0)
  })
})
