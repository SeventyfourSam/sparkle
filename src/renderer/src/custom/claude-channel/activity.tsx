import { useEffect, useState } from 'react'
import type { ClaudeMessage } from '../../../../shared/claude-channel'
import type { CodexRecord } from '../../../../shared/codex-web'
import { ContentBase, LinkedText } from '../codex-web/content-links'
import { DeferredSection } from '../codex-web/lazy-details'

function ActivityDetails({
  items,
  command,
  sessionId
}: {
  items: ClaudeMessage[]
  command: (action: string, params?: CodexRecord) => Promise<CodexRecord>
  sessionId: string
}): React.JSX.Element {
  const sources = items.map((item) => item.source).filter((value): value is string => !!value)
  const [stack, setStack] = useState<{ source: string; group: number }[]>(
    sources[0] ? [{ source: sources[0], group: 0 }] : []
  )
  const [result, setResult] = useState<{ items: ClaudeMessage[]; next?: string }>(),
    [error, setError] = useState('')
  const current = stack.at(-1)
  useEffect(() => {
    if (!current) return
    let disposed = false
    setResult(undefined)
    setError('')
    void command('historyDetail', { sessionId, source: current.source })
      .then((value) => {
        if (!disposed) setResult(value as { items: ClaudeMessage[]; next?: string })
      })
      .catch((error) => {
        if (!disposed) setError(error.message)
      })
    return () => {
      disposed = true
    }
  }, [current?.source, command, sessionId])
  const entries = result?.items || (!sources.length ? items : [])
  const next =
    current &&
    (result?.next
      ? { source: result.next, group: current.group }
      : sources[current.group + 1]
        ? { source: sources[current.group + 1], group: current.group + 1 }
        : undefined)
  return (
    <div className="claude-activity-details">
      {error ? (
        <p role="alert">{error}</p>
      ) : sources.length && !result ? (
        <p>正在加载执行记录…</p>
      ) : (
        entries.map((item) => (
          <ContentBase key={item.id} cwd={item.cwd}>
            <DeferredSection summary={item.role === 'assistant' ? '工具调用' : item.text}>
              {() => (
                <pre>
                  <LinkedText text={item.detail || item.text} />
                </pre>
              )}
            </DeferredSection>
          </ContentBase>
        ))
      )}
      <div className="claude-detail-pages">
        {stack.length > 1 && (
          <button onClick={() => setStack((old) => old.slice(0, -1))}>上一批</button>
        )}
        {next && <button onClick={() => setStack((old) => [...old, next])}>下一批</button>}
      </div>
    </div>
  )
}
export function Activity({
  items,
  command,
  sessionId
}: {
  items: ClaudeMessage[]
  command: (action: string, params?: CodexRecord) => Promise<CodexRecord>
  sessionId: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <details
      className="claude-tools"
      data-claude-message={items[0].id}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        工具与终端活动{' '}
        <span>· {items.reduce((sum, item) => sum + (item.toolCount || 1), 0)} 项</span>
      </summary>
      {open && <ActivityDetails items={items} command={command} sessionId={sessionId} />}
    </details>
  )
}
