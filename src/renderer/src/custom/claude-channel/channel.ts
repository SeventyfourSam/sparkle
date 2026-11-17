import { useCallback, useRef, useState } from 'react'
import { CLAUDE_BROWSER_PATH, type ClaudeChannelSession } from '../../../../shared/claude-channel'
import type { CodexRecord } from '../../../../shared/codex-web'
import { useGateway } from '../codex-web/client'

export const claudeStateLabels: Record<string, string> = {
  starting: '等待启动确认',
  connected: '桥接已连接',
  working: '处理中',
  waiting: '等待审批',
  offline: '已离线',
  stopped: '已停止'
}
export function useClaudeChannel() {
  const [sessions, setSessions] = useState<ClaudeChannelSession[]>([])
  const listeners = useRef(new Set<(message: CodexRecord) => void>())
  const drafts = useRef(
    new Map<string, { text: string; messageId?: { text: string; id: string } }>()
  )
  const { connected, command } = useGateway((message) => {
    if (message.type === 'sessions') setSessions(message.sessions)
    for (const notify of listeners.current) notify(message)
  }, CLAUDE_BROWSER_PATH)
  const subscribe = useCallback((notify: (message: CodexRecord) => void): (() => void) => {
    listeners.current.add(notify)
    return () => {
      listeners.current.delete(notify)
    }
  }, [])
  return { sessions, connected, command, subscribe, drafts }
}
export type ClaudeChannel = ReturnType<typeof useClaudeChannel>
