import type { CodexRecord } from '../../../shared/codex-web'
import type { CodexWebModel } from '../../../shared/codex-web-models'

export async function readModels(
  call: (method: string, params: CodexRecord) => Promise<CodexRecord>,
  provider?: string
): Promise<CodexWebModel[]> {
  const models = new Map<string, CodexWebModel>()
  const cursors = new Set<string>()
  let cursor: string | null = null
  do {
    const result = await call('model/list', {
      limit: 100,
      cursor,
      includeHidden: false,
      ...(provider ? { modelProvider: provider } : {})
    })
    if (!Array.isArray(result.data)) throw new Error('Codex 没有返回可选模型列表')
    for (const value of result.data) {
      if (typeof value?.model !== 'string' || !value.model) continue
      models.set(value.model, {
        model: value.model,
        displayName:
          typeof value.displayName === 'string' && value.displayName
            ? value.displayName
            : value.model,
        description: typeof value.description === 'string' ? value.description : '',
        defaultReasoningEffort:
          typeof value.defaultReasoningEffort === 'string' ? value.defaultReasoningEffort : '',
        supportedReasoningEfforts: Array.isArray(value.supportedReasoningEfforts)
          ? value.supportedReasoningEfforts.filter(
              (entry: CodexRecord) => typeof entry?.reasoningEffort === 'string'
            )
          : []
      })
    }
    cursor = result.nextCursor || null
    if (cursor && (typeof cursor !== 'string' || cursors.has(cursor) || cursors.size >= 20))
      throw new Error('Codex 模型列表分页无效，请重试')
    if (cursor) cursors.add(cursor)
  } while (cursor)
  return [...models.values()]
}

export function modelSettingsParams(message: CodexRecord, models: CodexWebModel[]): CodexRecord {
  const selected = models.find((entry) => entry.model === message.model)
  if (!selected) throw new Error('请选择当前 Codex 提供的模型')
  const params: CodexRecord = { threadId: String(message.threadId), model: selected.model }
  if (message.effort !== undefined) {
    if (
      !selected.supportedReasoningEfforts.some((entry) => entry.reasoningEffort === message.effort)
    )
      throw new Error('所选模型不支持这个推理强度，请重新选择')
    params.effort = message.effort
  }
  return params
}
