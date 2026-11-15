import type { CodexRecord } from '../../../../shared/codex-web'
import { threadSettingsPatch } from '../../../../shared/codex-web-models'
import {
  HISTORY_TEXT_LIMIT,
  isToolItem,
  visibleNarrative
} from '../../../../shared/codex-web-history'

export interface Conversation {
  thread?: CodexRecord
  turns: CodexRecord[]
  nextCursor?: string | null
  newerCursor?: string | null
  activeTurn?: CodexRecord | null
  loading: boolean
  subscribed?: boolean
  tokenUsage?: CodexRecord
  goal?: CodexRecord | null
  rateLimits?: CodexRecord
  plan?: CodexRecord[]
  diff?: string
  diffAvailable?: boolean
  historyNotice?: string
  questionAnswers?: Record<string, boolean>
  browsingHistory?: boolean
  windowTrimmed?: boolean
  error?: string
}
export const emptyConversation = (): Conversation => ({ turns: [], loading: true })

export function trimWindow(state: Conversation, limit = 20, offset = 0): Conversation {
  const all = state.turns.flatMap((turn) => turn.items || [])
  const ordered = state.browsingHistory ? all : [...all].reverse()
  const positions = new Map(all.map((item, index) => [item, index]))
  const accepted = new Set<CodexRecord>()
  let count = 0
  for (const item of ordered) {
    if (visibleNarrative(item)) {
      if (count >= offset && count < offset + limit) accepted.add(item)
      count++
    }
  }
  const indexes = all
    .map((item, index) => (accepted.has(item) ? index : -1))
    .filter((index) => index >= 0)
  const lower = indexes.length ? Math.min(...indexes) : Math.max(0, all.length - 160)
  const upper = state.browsingHistory && indexes.length ? Math.max(...indexes) : all.length
  let tools = 0
  for (const item of ordered) {
    const index = positions.get(item)!
    if (isToolItem(item) && index >= lower && index <= upper && tools++ < 160) accepted.add(item)
  }
  let dropped = false
  const turns = state.turns.flatMap((turn) => {
    const items = (turn.items || []).filter((item: CodexRecord) => accepted.has(item))
    if (
      (turn.items || []).some((item: CodexRecord) => visibleNarrative(item) && !accepted.has(item))
    )
      dropped = true
    if (!items.length && turn.status !== 'inProgress') return []
    return [items.length === (turn.items || []).length ? turn : { ...turn, items }]
  })
  return { ...state, turns, windowTrimmed: state.windowTrimmed || dropped }
}

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
  if (method === 'turn/diff/updated')
    return { ...state, diffAvailable: params.diffAvailable ?? !!params.diff }
  if (method === 'error')
    return { ...state, error: params.error?.message || params.message || '任务出错' }
  if (method === 'turn/started' || method === 'turn/completed') {
    return trimWindow({
      ...state,
      activeTurn:
        method === 'turn/started'
          ? { ...params.turn, items: [] }
          : state.activeTurn?.id === params.turn.id
            ? null
            : state.activeTurn,
      turns: mergeTurns(state.turns, [params.turn]),
      error: params.turn.error?.message
    })
  }
  if (
    !params.turnId ||
    (!method.startsWith('item/') && method !== 'item/started' && method !== 'item/completed')
  )
    return state
  const turns: CodexRecord[] = [...state.turns]
  const turnIndex = turns.findIndex((item) => item.id === params.turnId)
  let turn: CodexRecord | undefined =
    turnIndex < 0 ? undefined : { ...turns[turnIndex], items: [...turns[turnIndex].items] }
  if (turn) turns[turnIndex] = turn
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
        webTurnId: params.turnId,
        type: method.includes('reasoning')
          ? 'reasoning'
          : method.includes('commandExecution')
            ? 'commandExecution'
            : 'agentMessage'
      })
    }
    const item = { ...turn.items[index] }
    if (method === 'item/agentMessage/delta') {
      const text = (item.text || '') + params.delta
      item.text = text.slice(0, HISTORY_TEXT_LIMIT)
      if (text.length > HISTORY_TEXT_LIMIT) item.webDeferred = true
    }
    if (method === 'item/commandExecution/outputDelta')
      item.aggregatedOutput = ((item.aggregatedOutput || '') + params.delta).slice(-200000)
    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      const key = method.includes('summary') ? 'summary' : 'content'
      const part = params.summaryIndex ?? params.contentIndex ?? 0
      item[key] = [...(item[key] || [])]
      item[key][part] = ((item[key][part] || '') + params.delta).slice(0, 2000)
      item.webDeferred = true
    }
    turn.items[index] = item
  }
  return trimWindow({ ...state, turns })
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
