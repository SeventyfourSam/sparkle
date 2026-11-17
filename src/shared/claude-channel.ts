export const CLAUDE_BROWSER_PATH = '/claude/browser'
export const CLAUDE_BRIDGE_PATH = '/claude/channel'

export interface ClaudeChannelSession {
  id: string
  nativeId?: string
  title: string
  cwd: string
  model?: string
  connected: boolean
  owned: boolean
  terminal: boolean
  state: 'starting' | 'connected' | 'working' | 'waiting' | 'offline' | 'stopped'
  createdAt: number
  error?: string
}

export interface ClaudeMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'notice'
  text: string
  at: number
  state?: 'sending' | 'submitted' | 'replied' | 'failed'
  detail?: string
  cwd?: string
  source?: string
  toolCount?: number
  hasTools?: boolean
  truncated?: boolean
}

export const isClaudeMessage = (item: ClaudeMessage): boolean => item.role !== 'tool'

// Activity summaries travel alongside messages and never consume their quota.
export function claudeMessageWindow(
  items: ClaudeMessage[],
  limit: number,
  offset = 0
): [number, number] {
  const positions = items.flatMap((item, index) => (isClaudeMessage(item) ? [index] : []))
  return [
    offset ? (positions[offset] ?? items.length) : 0,
    positions[offset + limit] ?? items.length
  ]
}

export interface ClaudePermission {
  id: string
  tool: string
  description: string
  preview: string
  state: 'pending' | 'submitted'
}

export interface ClaudeHistoryPage {
  items: ClaudeMessage[]
  before: string | null
  after: string | null
  notice?: string
}

export interface ClaudeChannelDescriptor {
  version: 1
  url: string
  hookUrl: string
  token: string
  runtime: string
  bridge: string
}
