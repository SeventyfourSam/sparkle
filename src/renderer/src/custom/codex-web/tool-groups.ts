import type { CodexRecord } from '../../../../shared/codex-web'

const narrativeTypes = new Set([
  'userMessage',
  'agentMessage',
  'reasoning',
  'plan',
  'contextCompaction'
])

export interface TranscriptGroup {
  id: string
  tools: boolean
  items: CodexRecord[]
  error?: string
  interrupted?: boolean
}

function hidden(item: CodexRecord): boolean {
  if (item.type === 'reasoning')
    return (
      !item.webHasContent && ![...(item.summary || []), ...(item.content || [])].join('\n').trim()
    )
  if (item.type === 'agentMessage' || item.type === 'plan')
    return typeof item.text !== 'string' || !item.text.trim()
  return false
}

export function groupToolItems(items: CodexRecord[]): TranscriptGroup[] {
  const groups: TranscriptGroup[] = []
  for (const item of items) {
    if (hidden(item)) continue
    const tools = !narrativeTypes.has(item.type)
    const previous = groups.at(-1)
    if (tools && previous?.tools) previous.items.push(item)
    else groups.push({ id: item.id, tools, items: [item] })
  }
  return groups
}

export function groupConversationItems(turns: CodexRecord[]): TranscriptGroup[] {
  const groups: TranscriptGroup[] = []
  for (const turn of turns) {
    for (const group of groupToolItems(turn.items || [])) {
      const previous = groups.at(-1)
      // A turn boundary or an empty reasoning snapshot is not a visible separator.
      if (group.tools && previous?.tools) previous.items.push(...group.items)
      else groups.push({ ...group, id: `${turn.id}:${group.id}` })
    }
    if (turn.error?.message)
      groups.push({ id: `${turn.id}:error`, tools: false, items: [], error: turn.error.message })
    if (turn.status === 'interrupted')
      groups.push({ id: `${turn.id}:interrupted`, tools: false, items: [], interrupted: true })
  }
  return groups
}
