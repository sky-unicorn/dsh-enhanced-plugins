/** Dictionary keys owned by the inline edit-last-message bubble. */
export type EditLastMessageLocaleKey =
  | 'action.copy'
  | 'action.copied'
  | 'action.edit'
  | 'action.cancel'
  | 'action.save'
  | 'action.saving'
  | 'button.cancel'
  | 'button.resend'
  | 'button.saving'
  | 'editor.label'
  | 'editor.hint'
  | 'error.empty'
  | 'error.failed'
  | 'content.extraBlock'
  | 'content.truncated'
  | 'image.label'
  | 'image.open'
  | 'image.openNamed'
  | 'image.loading'
  | 'image.loadFailed'
  | 'image.preview'
  | 'image.closePreview'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy owned by the last-user-message inline editor. */
    'edit-last-message': EditLastMessageLocaleKey
  }
}

/** Simplified Chinese copy. */
export const zh: Record<EditLastMessageLocaleKey, string> = {
  'action.copy': '复制',
  'action.copied': '复制成功',
  'action.edit': '编辑上一条消息',
  'action.cancel': '取消编辑',
  'action.save': '保存并重新发送',
  'action.saving': '正在截断并重新发送',
  'button.cancel': '取消',
  'button.resend': '重新发送',
  'button.saving': '发送中…',
  'editor.label': '编辑上一条消息',
  'editor.hint': 'Ctrl/⌘ + Enter 重新发送 · Esc 取消',
  'error.empty': '消息内容不能为空',
  'error.failed': '编辑发送失败：{message}',
  'content.extraBlock': '额外消息内容',
  'content.truncated': '内容过长，已截断（共 {total} 项）',
  'image.label': '图片',
  'image.open': '查看原图',
  'image.openNamed': '{label}，点击查看原图',
  'image.loading': '图片加载中…',
  'image.loadFailed': '图片加载失败，点击重试',
  'image.preview': '原图预览',
  'image.closePreview': '关闭原图预览',
}

/** English copy. */
export const en: Record<EditLastMessageLocaleKey, string> = {
  'action.copy': 'Copy',
  'action.copied': 'Copied',
  'action.edit': 'Edit last message',
  'action.cancel': 'Cancel editing',
  'action.save': 'Save and resend',
  'action.saving': 'Truncating and resending',
  'button.cancel': 'Cancel',
  'button.resend': 'Resend',
  'button.saving': 'Sending…',
  'editor.label': 'Edit last message',
  'editor.hint': 'Ctrl/⌘ + Enter to resend · Esc to cancel',
  'error.empty': 'Message content cannot be empty',
  'error.failed': 'Edit and resend failed: {message}',
  'content.extraBlock': 'Additional message content',
  'content.truncated': 'Content truncated ({total} items total)',
  'image.label': 'Image',
  'image.open': 'View original',
  'image.openNamed': '{label}, click to view original',
  'image.loading': 'Loading image…',
  'image.loadFailed': 'Image failed to load; click to retry',
  'image.preview': 'Original image preview',
  'image.closePreview': 'Close original image preview',
}
