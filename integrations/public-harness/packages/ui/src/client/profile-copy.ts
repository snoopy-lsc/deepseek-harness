/** Profile labels and operation feedback shared by personal and administration forms. */
export const profileCopy = {
  en: {
    profileEdit: 'Edit profile', profileName: 'Name', profileEmail: 'Email', profilePhone: 'Contact phone', profilePhoneHint: 'For contact only; this number is not verified and cannot be used to sign in.',
    profileEmployeeId: 'Employee ID', profileDepartment: 'Department', profileJobTitle: 'Job title', profileOrganization: 'Organization information',
    profileOrganizationHint: 'Your administrator manages your employee ID, department and job title.', profileSsoHint: 'Your company account manages your name.', profileEmailHint: 'The sign-in email cannot be changed here.',
    profileSave: 'Save profile', profileSaving: 'Saving…', profileSaved: 'Profile saved.', profileFailed: 'Could not save the profile. Your changes are still here; try again.', profileLoadFailed: 'Could not load the profile.', profileRetry: 'Retry',
    profileInvalidName: 'Enter a name with 1–100 characters.', profileInvalidPhone: 'Use at most 40 characters for the phone number.', profileInvalidEmployeeId: 'Use at most 64 characters for the employee ID.',
    profileInvalidDepartment: 'Use at most 100 characters for the department.', profileInvalidJobTitle: 'Use at most 100 characters for the job title.', profileManaged: 'Your company account manages this name. Reload the profile to get the latest name.',
    profileNotSet: 'Not set', profileCancel: 'Close', profileAvatar: 'Avatar', profileChooseAvatar: 'Choose image', profileRemoveAvatar: 'Remove avatar', profileUploadAvatar: 'Save avatar', profileDiscardAvatar: 'Discard image',
    profileAvatarHint: 'PNG, JPEG or WebP, up to 5 MB. The image is resized on this device before upload.', profileAvatarBad: 'Choose a valid PNG, JPEG or WebP image up to 5 MB.', profileAvatarFailed: 'Could not update the avatar. Try again.',
    profileAvatarSaved: 'Avatar updated.', profileAvatarBusy: 'Processing image…', profileAvatarPreview: 'Avatar preview',
  },
  zh: {
    profileEdit: '编辑资料', profileName: '名称', profileEmail: '邮箱', profilePhone: '联系电话', profilePhoneHint: '仅用于联系；此号码未经验证，不能用于登录',
    profileEmployeeId: '工号', profileDepartment: '部门', profileJobTitle: '职位', profileOrganization: '组织信息',
    profileOrganizationHint: '工号、部门和职位由管理员维护', profileSsoHint: '名称由企业账号统一管理', profileEmailHint: '登录邮箱不能在此修改',
    profileSave: '保存资料', profileSaving: '保存中…', profileSaved: '资料已保存', profileFailed: '资料保存失败，修改内容已保留，请重试', profileLoadFailed: '无法加载个人资料', profileRetry: '重试',
    profileInvalidName: '请输入 1–100 个字符的名称', profileInvalidPhone: '联系电话不能超过 40 个字符', profileInvalidEmployeeId: '工号不能超过 64 个字符',
    profileInvalidDepartment: '部门不能超过 100 个字符', profileInvalidJobTitle: '职位不能超过 100 个字符', profileManaged: '此名称由企业账号管理，请重新加载资料以获取最新名称',
    profileNotSet: '未填写', profileCancel: '关闭', profileAvatar: '头像', profileChooseAvatar: '选择图片', profileRemoveAvatar: '移除头像', profileUploadAvatar: '保存头像', profileDiscardAvatar: '取消图片',
    profileAvatarHint: '支持 PNG、JPEG、WebP，最大 5 MB；上传前会在当前设备上缩小图片', profileAvatarBad: '请选择有效的 PNG、JPEG 或 WebP 图片，且不超过 5 MB', profileAvatarFailed: '头像更新失败，请重试',
    profileAvatarSaved: '头像已更新', profileAvatarBusy: '正在处理图片…', profileAvatarPreview: '头像预览',
  },
}

/** Shared profile dictionary key. */
export type ProfileCopyKey = keyof typeof profileCopy.en
/** Translator accepting the profile labels within either owning namespace. */
export type ProfileT = (key: ProfileCopyKey) => string
