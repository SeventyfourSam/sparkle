import type { CodexRecord } from './codex-web'
import { asyncQuestions, formatQuestionReplies, itemQuestionReplies } from './codex-web-questions'

export const HISTORY_WINDOW = 10
export const HISTORY_TEXT_LIMIT = 12000
export const TOOL_OUTPUT_LIMIT = 64000
const narrative = new Set(['userMessage', 'agentMessage', 'reasoning', 'plan', 'contextCompaction'])
export const isToolItem = (item: CodexRecord): boolean => !narrative.has(item.type)
export function visibleNarrative(item: CodexRecord): boolean {
  if (isToolItem(item)) return false
  if (item.type === 'reasoning')
    return (
      !!item.webHasContent || !![...(item.summary || []), ...(item.content || [])].join('').trim()
    )
  if (item.type === 'userMessage') return !!item.content?.length
  if (item.type === 'contextCompaction') return true
  if (asyncQuestions(item)) return true
  return typeof item.text === 'string' && !!item.text.trim()
}

export function previewItem(item: CodexRecord, turnId: string): CodexRecord {
  const result: CodexRecord = { id: item.id, type: item.type, webTurnId: turnId }
  for (const key of ['status', 'exitCode', 'durationMs', 'phase', 'server', 'tool', 'name'])
    if (item[key] !== undefined) result[key] = item[key]
  for (const key of ['command', 'cwd'])
    if (typeof item[key] === 'string') result[key] = item[key].slice(0, 512)
  if (isToolItem(item)) return { ...result, webDeferred: true }
  if (typeof item.text === 'string') {
    result.text = item.text.slice(0, HISTORY_TEXT_LIMIT)
    if (result.text.length < item.text.length) result.webDeferred = true
  }
  const questions = asyncQuestions(item)
  if (questions) {
    result.delivery = 'async'
    result.questions = questions
  }
  if (item.type === 'reasoning') {
    result.summary = [(item.summary || []).join('\n').slice(0, 2000)]
    result.content = []
    result.webHasContent = visibleNarrative(item)
    result.webDeferred = true
  }
  if (item.type === 'userMessage') {
    const replies = itemQuestionReplies(item)
    if (replies.length) {
      result.webQuestionReplyIds = replies.map((reply) => reply.questionItemId)
      const text = formatQuestionReplies(replies)
      result.content = [{ type: 'text', text: text.slice(0, HISTORY_TEXT_LIMIT) }]
      if (text.length > HISTORY_TEXT_LIMIT) result.webDeferred = true
      return result
    }
    let remaining = HISTORY_TEXT_LIMIT
    result.content = (item.content || []).map((input: CodexRecord) => {
      if (input.type !== 'text') return { type: input.type, name: input.name || '附件' }
      const text = String(input.text || '').slice(0, Math.max(0, remaining))
      remaining -= text.length
      if (text !== input.text) result.webDeferred = true
      return { type: 'text', text }
    })
  }
  return result
}

export function boundedDetail(item: CodexRecord, turnId: string): CodexRecord {
  const result: CodexRecord = { ...item, webTurnId: turnId, webDeferred: false }
  let remaining = TOOL_OUTPUT_LIMIT
  const clip = (text: string): string => {
    const value = text.slice(0, Math.max(0, remaining))
    remaining -= value.length
    if (value.length < text.length) result.webTruncated = true
    return value
  }
  for (const key of ['text', 'aggregatedOutput', 'output', 'command'])
    if (typeof result[key] === 'string') result[key] = clip(result[key])
  for (const key of ['summary', 'content'])
    if (item.type === 'reasoning' && Array.isArray(result[key]))
      result[key] = result[key].map((text: string) => clip(String(text)))
  if (item.type === 'userMessage' && Array.isArray(item.content)) {
    const replies = itemQuestionReplies(item)
    if (replies.length) {
      result.webQuestionReplyIds = replies.map((reply) => reply.questionItemId)
      result.content = [{ type: 'text', text: clip(formatQuestionReplies(replies)) }]
    } else
      result.content = item.content.map((input: CodexRecord) =>
        input.type === 'text'
          ? { type: 'text', text: clip(String(input.text || '')) }
          : { type: input.type, name: input.name || '附件' }
      )
  }
  if (Array.isArray(item.changes))
    result.changes = item.changes
      .slice(0, 100)
      .map((change: CodexRecord) => ({ ...change, diff: clip(String(change.diff || '')) }))
  if (item.changes?.length > 100) result.webTruncated = true
  for (const key of ['result', 'arguments'])
    if (result[key] !== undefined) {
      const text = JSON.stringify(result[key])
      if (text.length > remaining) {
        result.output = clip(text)
        delete result[key]
      } else remaining -= text.length
    }
  // Future tool types can carry arbitrary payloads; keep their detail response bounded too.
  if (JSON.stringify(result).length > TOOL_OUTPUT_LIMIT + 8000)
    return {
      id: item.id,
      type: item.type,
      webTurnId: turnId,
      webDeferred: false,
      webTruncated: true,
      output: JSON.stringify(result).slice(0, TOOL_OUTPUT_LIMIT)
    }
  return result
}
