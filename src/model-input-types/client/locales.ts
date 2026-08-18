/** English copy for the pi-ai model request-type card. */
export const en = {
  title: 'pi-ai model request types',
  description: 'Declare whether configured models accept text or image requests.',
  expand: 'Expand',
  collapse: 'Collapse',
  readOnly: 'Settings are read-only in this deployment.',
  warning: 'These capabilities are declarations; the provider endpoint is not probed for image support.',
  empty: 'No configured pi-ai model overrides were found.',
  emptyHint: 'Add model overrides on the Models page or in settings.yaml, then choose their request type here.',
  modelType: 'Model type',
  modelTypeAria: 'Model type for {provider} / {model}',
  providerDefault: 'Provider default',
  textOnly: 'Text only',
  textAndImages: 'Text and images',
  saving: 'Saving model request type…',
  saved: 'Model request type saved.',
  conflict: 'Settings changed elsewhere. The latest values were reloaded; choose the model type again.',
} as const

/** Locale key union for the card. */
export type ModelInputTypesLocaleKey = keyof typeof en

/** Chinese copy kept key-identical to {@link en}. */
export const zh: { [Key in ModelInputTypesLocaleKey]: string } = {
  title: 'pi-ai 模型请求类型',
  description: '声明已配置模型接受纯文本请求还是图片请求。',
  expand: '展开',
  collapse: '收起',
  readOnly: '当前部署中的设置为只读。',
  warning: '这些能力来自人工声明；页面不会探测提供方端点是否真正支持图片。',
  empty: '没有找到已配置的 pi-ai 模型覆盖。',
  emptyHint: '请先在“模型”页面或 settings.yaml 中添加模型覆盖，再在此选择请求类型。',
  modelType: '模型类型',
  modelTypeAria: '{provider} / {model} 的模型类型',
  providerDefault: '提供方默认',
  textOnly: '仅文本',
  textAndImages: '文本与图片',
  saving: '正在保存模型请求类型…',
  saved: '模型请求类型已保存。',
  conflict: '设置已在其他位置变更。已重新读取最新值，请再次选择模型类型。',
}
