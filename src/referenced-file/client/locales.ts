/** Dictionary keys owned by the # file candidate menu. */
export type ReferencedFileLocaleKey =
  | 'title'
  | 'hint'
  | 'loading'
  | 'empty'
  | 'error'
  | 'truncated'
  | 'suggestions.aria'
  | 'file.aria'
  | 'size.bytes'
  | 'size.kilobytes'
  | 'size.megabytes'

/** Simplified Chinese copy. */
export const zh: Record<ReferencedFileLocaleKey, string> = {
  title: '引用工作区文件',
  hint: '↑↓ 选择 · Enter 引用',
  loading: '正在查找工作区文件…',
  empty: '没有匹配的文件',
  error: '无法读取文件列表',
  truncated: '结果受扫描上限限制，请继续输入以缩小范围',
  'suggestions.aria': '文件引用候选',
  'file.aria': '引用文件 {path}',
  'size.bytes': '{value} 字节',
  'size.kilobytes': '{value} KB',
  'size.megabytes': '{value} MB',
}

/** English copy. */
export const en: Record<ReferencedFileLocaleKey, string> = {
  title: 'Reference workspace file',
  hint: '↑↓ Select · Enter to reference',
  loading: 'Searching workspace files…',
  empty: 'No matching files',
  error: 'Unable to read the file list',
  truncated: 'Results hit the scan limit; keep typing to narrow the search',
  'suggestions.aria': 'File reference suggestions',
  'file.aria': 'Reference file {path}',
  'size.bytes': '{value} B',
  'size.kilobytes': '{value} KB',
  'size.megabytes': '{value} MB',
}
