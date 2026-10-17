/** System Admin knowledge base copy (share requests, inventory, org knowledge bases, limits), en and zh with identical keys. */
export const kbAdminCopy = {
  en: {
    kbRequests: 'Share requests', kbPending: 'Pending', kbAllRequests: 'All', kbNoRequests: 'No share requests are waiting.', kbNoHistory: 'No share requests yet.',
    kbFrom: 'From {email}', kbSubmitted: 'Submitted {date}', kbFiles: '{n} files · {size}', kbNote: 'Note: {note}', kbCurrent: 'Currently shared since {date}',
    kbReview: 'Review', kbReviewTitle: 'Review {title}', kbReviewHint: 'The pinned commit {commit}. Readers keep copies of what they open, even after a revoke.',
    kbFilesTitle: 'Files', kbRemoved: 'Removed since the current publication: {paths}', kbStatus_added: 'New', kbStatus_changed: 'Changed', kbStatus_same: 'Unchanged',
    kbOpenFile: 'Opening a file is recorded in the audit log.', kbBinary: 'Binary file; no preview.', kbCompileLog: 'Compile log', kbRecentJobs: 'Recent compiles: {jobs}',
    kbScope: 'Who can read it', kbScopeCompany: 'Whole company', kbScopeGroups: 'Departments and groups', kbScopeUsers: 'Individual users', kbScopeEmpty: 'Pick at least one group or user.',
    kbIncludeRaw: 'Include raw sources (raw/)', kbApprove: 'Approve and share', kbReject: 'Reject', kbRejectReason: 'Reason shown to the author', kbRejectTitle: 'Reject {title}',
    kbApproved: 'Approved and shared. Readers in scope see it in ~/kb/shared.', kbRejected: 'Rejected.', kbReqState_pending: 'Pending', kbReqState_approved: 'Approved', kbReqState_rejected: 'Rejected',
    kbReqState_withdrawn: 'Withdrawn', kbReqState_expired: 'Expired', kbKind_personal: 'Personal', kbKind_org: 'Company', kbSearchPeople: 'Add a group or user', kbAdd: 'Add',
    diffCopy: 'Copy', diffCopied: 'Copied', diffCollapse: 'Collapse', diffExpand: 'Show {n} more lines', diffCode: 'Text', diffWrap: 'Wrap lines', diffUnwrap: 'Do not wrap',
  },
  zh: {
    kbRequests: '共享申请', kbPending: '待审核', kbAllRequests: '全部', kbNoRequests: '没有待审核的共享申请。', kbNoHistory: '还没有共享申请。',
    kbFrom: '来自 {email}', kbSubmitted: '提交于 {date}', kbFiles: '{n} 个文件 · {size}', kbNote: '说明：{note}', kbCurrent: '自 {date} 起已共享',
    kbReview: '审核', kbReviewTitle: '审核 {title}', kbReviewHint: '固定的提交 {commit}。读者打开过的内容会保留副本，撤销后也一样。',
    kbFilesTitle: '文件', kbRemoved: '相对当前发布已删除：{paths}', kbStatus_added: '新增', kbStatus_changed: '已修改', kbStatus_same: '未变',
    kbOpenFile: '打开文件会记录到审计日志。', kbBinary: '二进制文件，无法预览。', kbCompileLog: '编译日志', kbRecentJobs: '最近编译：{jobs}',
    kbScope: '可见范围', kbScopeCompany: '全公司', kbScopeGroups: '部门和用户组', kbScopeUsers: '指定用户', kbScopeEmpty: '请至少选择一个用户组或用户。',
    kbIncludeRaw: '包含原始资料（raw/）', kbApprove: '批准并共享', kbReject: '驳回', kbRejectReason: '展示给作者的原因', kbRejectTitle: '驳回 {title}',
    kbApproved: '已批准并共享，范围内的读者可在 ~/kb/shared 中看到。', kbRejected: '已驳回。', kbReqState_pending: '待审核', kbReqState_approved: '已批准', kbReqState_rejected: '已驳回',
    kbReqState_withdrawn: '已撤回', kbReqState_expired: '已过期', kbKind_personal: '个人', kbKind_org: '公司', kbSearchPeople: '添加用户组或用户', kbAdd: '添加',
    diffCopy: '复制', diffCopied: '已复制', diffCollapse: '收起', diffExpand: '展开其余 {n} 行', diffCode: '文本', diffWrap: '自动换行', diffUnwrap: '不换行',
  },
}
