import type { CodexRecord } from '../../../shared/codex-web'
import { boundedDetail, TOOL_OUTPUT_LIMIT } from '../../../shared/codex-web-history'
export { recentHistory } from './history-pages'
type Call = (method: string, params: CodexRecord) => Promise<CodexRecord>

export class LiveItemCache {
  private items = new Map<string, { item: CodexRecord; revision: number; completed: boolean }>()
  private sequence = 0
  static key(turnId: string, itemId: string): string {
    return JSON.stringify([turnId, itemId])
  }
  remember(method: string, params: CodexRecord): CodexRecord | undefined {
    const id = params.item?.id || params.itemId
    if (!params.turnId || !id) return
    const key = LiveItemCache.key(params.turnId, id)
    let value = this.items.get(key)
    if (params.item)
      value = {
        item: boundedDetail(params.item, params.turnId),
        revision: ++this.sequence,
        completed: method === 'item/completed'
      }
    else if (typeof params.delta === 'string') {
      const type = method.includes('reasoning')
        ? 'reasoning'
        : method.includes('agentMessage')
          ? 'agentMessage'
          : 'commandExecution'
      const item = { ...(value?.item || { id, type, webTurnId: params.turnId }) }
      if (type === 'reasoning') {
        const key = method.includes('summary') ? 'summary' : 'content'
        const index = params.summaryIndex ?? params.contentIndex ?? 0
        item[key] = [...(item[key] || [])]
        item[key][index] = ((item[key][index] || '') + params.delta).slice(-TOOL_OUTPUT_LIMIT)
      } else {
        const key = type === 'agentMessage' ? 'text' : 'aggregatedOutput'
        item[key] = ((item[key] || '') + params.delta).slice(-TOOL_OUTPUT_LIMIT)
      }
      item.webPartial = true
      value = { item, revision: ++this.sequence, completed: false }
    }
    if (!value) return
    this.items.delete(key)
    this.items.set(key, value)
    while (this.items.size > 32) this.items.delete(this.items.keys().next().value!)
    return {
      ...params,
      method,
      item: params.item ? value.item : undefined,
      revision: value.revision,
      delta: typeof params.delta === 'string' ? params.delta.slice(-TOOL_OUTPUT_LIMIT) : undefined
    }
  }
  async read(call: Call, threadId: string, turnId: string, itemId: string): Promise<CodexRecord> {
    const cached = this.items.get(LiveItemCache.key(turnId, itemId))
    if (cached && !cached.completed)
      return { item: { ...cached.item, webPartial: true }, revision: cached.revision }
    try {
      const result = await call('thread/items/read', { threadId, turnId, itemIds: [itemId] })
      const found = result.data?.find(
        (entry: CodexRecord) => entry.item?.id === itemId && entry.turnId === turnId
      )
      if (found) return { item: boundedDetail(found.item, turnId), revision: cached?.revision || 0 }
    } catch (error) {
      if (!cached) throw error
    }
    if (cached) return { item: cached.item, revision: cached.revision }
    throw new Error('此条目尚未保存，请稍后重试')
  }
}
