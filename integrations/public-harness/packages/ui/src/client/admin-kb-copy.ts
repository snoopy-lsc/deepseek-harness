/** System Admin copy for groups and knowledge bases, merged into the administration dictionaries. */
import { kbAdminCopy } from './admin-kb-text.ts'
import { pluginAdminCopy } from './admin-plugins-text.ts'
export const groupAdminCopy = {
  en: {
    groups: 'Groups', groupNew: 'New local group', groupNewHint: 'Local groups are managed here; departments and groups from the company directory refresh at sign-in and reconciliation.',
    groupName: 'Name', groupCreate: 'Create group', groupLocal: 'Local groups', groupSynced: 'Directory departments and groups',
    groupSyncedHint: 'OIDC and SAML groups refresh at sign-in only; LDAP, WeCom and DingTalk also at each reconciliation.',
    groupNoLocal: 'No local groups yet.', groupNoSynced: 'No directory groups have been seen yet.', groupMembers: '{n} members', groupRefreshed: 'Updated {date}',
    groupMembersOpen: 'Members', groupRename: 'Rename', groupAlias: 'Alias', groupAliasHint: 'The alias is shown instead of the directory value. It is display only and never grants access. Leave empty to clear it.',
    groupLocalMembersHint: 'Adding or removing members may change who can read group-scoped knowledge bases.', groupSyncedMembersHint: 'Members come from the company directory and cannot be edited here.',
    groupNoMembers: 'No members.', groupAdd: 'Add member', userGroups: 'Groups: {groups}',
    ...kbAdminCopy.en,
    ...pluginAdminCopy.en,
  },
  zh: {
    groups: '用户组', groupNew: '新建本地用户组', groupNewHint: '本地用户组在此管理；企业目录中的部门和用户组会在登录和目录同步时刷新。',
    groupName: '名称', groupCreate: '创建用户组', groupLocal: '本地用户组', groupSynced: '目录部门和用户组',
    groupSyncedHint: 'OIDC 和 SAML 用户组只在登录时刷新；LDAP、企业微信和钉钉还会在每次目录同步时刷新。',
    groupNoLocal: '还没有本地用户组。', groupNoSynced: '尚未收到任何目录用户组。', groupMembers: '{n} 名成员', groupRefreshed: '更新于 {date}',
    groupMembersOpen: '成员', groupRename: '重命名', groupAlias: '别名', groupAliasHint: '别名会替代目录中的原始值显示，仅用于展示，不授予任何权限。留空即清除。',
    groupLocalMembersHint: '增删成员可能改变谁能阅读按用户组共享的知识库。', groupSyncedMembersHint: '成员来自企业目录，不能在此编辑。',
    groupNoMembers: '没有成员。', groupAdd: '添加成员', userGroups: '用户组：{groups}',
    ...kbAdminCopy.zh,
    ...pluginAdminCopy.zh,
  },
}
