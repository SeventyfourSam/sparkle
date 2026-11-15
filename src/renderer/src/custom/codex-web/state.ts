import type { CodexRecord } from '../../../../shared/codex-web'
import { threadSettingsPatch } from '../../../../shared/codex-web-models'

export interface Conversation {
  thread?: CodexRecord
  turns: CodexRecord[]
  nextCursor?: string | null
  loading: boolean
  subscribed?: boolean
  tokenUsage?: CodexRecord
  goal?: CodexRecord | null
  rateLimits?: CodexRecord
  plan?: CodexRecord[]
  diff?: string
  error?: string
}
export const emptyConversation = (): Conversation => ({ turns: [], loading: true })

export function mergeTurns(first: CodexRecord[], second: CodexRecord[]): CodexRecord[] {
  const result: CodexRecord[] = first.map((turn) => ({ ...turn, items: [...(turn.items || [])] }))
  for (const turn of second) {
    const index = result.findIndex((item) => item.id === turn.id)
    if (index < 0) {
      result.push({ ...turn, items: [...(turn.items || [])] })
      continue
    }
    const items = new Map<string, CodexRecord>(
      result[index].items.map((item: CodexRecord) => [item.id, item])
    )
    for (const item of turn.items || []) items.set(item.id, { ...items.get(item.id), ...item })
    result[index] = { ...result[index], ...turn, items: [...items.values()] }
  }
  return result
}

export function reduceEvent(
  state: Conversation,
  method: string,
  params: CodexRecord
): Conversation {
  if (method === 'thread/status/changed')
    return { ...state, thread: { ...state.thread, status: params.status } }
  if (method === 'thread/settings/updated' && params.threadSettings)
    return { ...state, thread: { ...state.thread, ...threadSettingsPatch(params.threadSettings) } }
  if (method === 'thread/tokenUsage/updated') return { ...state, tokenUsage: params.tokenUsage }
  if (method === 'thread/goal/updated') return { ...state, goal: params.goal }
  if (method === 'thread/goal/cleared') return { ...state, goal: null }
  if (method === 'account/rateLimits/updated') return { ...state, rateLimits: params }
  if (method === 'turn/plan/updated') return { ...state, plan: params.plan }
  if (method === 'turn/diff/updated') return { ...state, diff: params.diff }
  if (method === 'error')
    return { ...state, error: params.error?.message || params.message || '任务出错' }
  if (method === 'turn/started' || method === 'turn/completed') {
    return {
      ...state,
      turns: mergeTurns(state.turns, [params.turn]),
      error: params.turn.error?.message
    }
  }
  if (
    !params.turnId ||
    (!method.startsWith('item/') && method !== 'item/started' && method !== 'item/completed')
  )
    return state
  const turns: CodexRecord[] = state.turns.map((turn) => ({ ...turn, items: [...turn.items] }))
  let turn = turns.find((item) => item.id === params.turnId)
  if (!turn) {
    turn = { id: params.turnId, items: [], status: 'inProgress' }
    turns.push(turn)
  }
  if (params.item) {
    const index = turn.items.findIndex((item: CodexRecord) => item.id === params.item.id)
    if (index < 0) turn.items.push(params.item)
    else turn.items[index] = { ...turn.items[index], ...params.item }
  } else if (typeof params.delta === 'string' && params.itemId) {
    let index = turn.items.findIndex((item: CodexRecord) => item.id === params.itemId)
    if (index < 0) {
      index = turn.items.length
      turn.items.push({
        id: params.itemId,
        type: method.includes('reasoning')
          ? 'reasoning'
          : method.includes('commandExecution')
            ? 'commandExecution'
            : 'agentMessage'
      })
    }
    const item = { ...turn.items[index] }
    if (method === 'item/agentMessage/delta') item.text = (item.text || '') + params.delta
    if (method === 'item/commandExecution/outputDelta')
      item.aggregatedOutput = ((item.aggregatedOutput || '') + params.delta).slice(-200000)
    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      const key = method.includes('summary') ? 'summary' : 'content'
      const part = params.summaryIndex ?? params.contentIndex ?? 0
      item[key] = [...(item[key] || [])]
      item[key][part] = (item[key][part] || '') + params.delta
    }
    turn.items[index] = item
  }
  return { ...state, turns }
}

export function statusLabel(status?: CodexRecord): { text: string; kind: string } {
  if (status?.type === 'active') {
    if (status.activeFlags?.includes('waitingOnApproval'))
      return { text: '等待审批', kind: 'attention' }
    if (status.activeFlags?.includes('waitingOnUserInput'))
      return { text: '等待回答', kind: 'attention' }
    return { text: '进行中', kind: 'active' }
  }
  if (status?.type === 'systemError') return { text: '发生错误', kind: 'error' }
  if (status?.type === 'notLoaded') return { text: '已卸载', kind: 'offline' }
  if (status?.type === 'offline') return { text: '离线', kind: 'offline' }
  return { text: '空闲', kind: 'idle' }
}
