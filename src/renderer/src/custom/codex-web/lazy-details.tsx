import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { CodexRecord } from '../../../../shared/codex-web'
import { TOOL_OUTPUT_LIMIT } from '../../../../shared/codex-web-history'
import { LinkedText } from './content-links'

type Target = { instanceId: string; threadId: string }
export const HistoryContext = createContext<{
  target?: Target
  command: (action: string, params?: CodexRecord) => Promise<CodexRecord>
}>({ command: async () => ({}) })
const listeners = new Map<string, Set<(event: CodexRecord) => void>>()
const keyOf = (instanceId: string, threadId: string, turnId: string, itemId: string): string =>
  JSON.stringify([instanceId, threadId, turnId, itemId])
export function publishDetail(event: CodexRecord): void {
  const key = keyOf(event.instanceId, event.threadId, event.turnId, event.item?.id || event.itemId)
  for (const notify of listeners.get(key) || []) notify(event)
}
function applyDetail(item: CodexRecord, event: CodexRecord): CodexRecord {
  if (event.item) return event.item
  if (typeof event.delta !== 'string') return item
  if (event.method?.includes('agentMessage'))
    return { ...item, text: ((item.text || '') + event.delta).slice(-TOOL_OUTPUT_LIMIT) }
  if (event.method?.includes('reasoning')) {
    const key = event.method.includes('summary') ? 'summary' : 'content'
    const index = event.summaryIndex ?? event.contentIndex ?? 0
    const values = [...(item[key] || [])]
    values[index] = ((values[index] || '') + event.delta).slice(-TOOL_OUTPUT_LIMIT)
    return { ...item, [key]: values }
  }
  return {
    ...item,
    aggregatedOutput: ((item.aggregatedOutput || '') + event.delta).slice(-TOOL_OUTPUT_LIMIT),
    webPartial: true
  }
}

function DetailBody({
  item,
  render
}: {
  item: CodexRecord
  render: (detail: CodexRecord) => ReactNode
}): React.JSX.Element {
  const { target, command } = useContext(HistoryContext)
  const [detail, setDetail] = useState<CodexRecord>()
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const revision = useRef(-1)
  useEffect(() => {
    let disposed = false
    let hydrated = false
    const buffered: CodexRecord[] = []
    if (!target || !item.webTurnId) {
      setError('此条目暂不可读取')
      return
    }
    const key = keyOf(target.instanceId, target.threadId, item.webTurnId, item.id)
    const receive = (event: CodexRecord): void => {
      if (!hydrated) {
        buffered.push(event)
        if (buffered.length > 100) buffered.shift()
        return
      }
      if (event.revision <= revision.current) return
      revision.current = event.revision
      setDetail((old) => applyDetail(old || item, event))
    }
    const group = listeners.get(key) || new Set()
    group.add(receive)
    listeners.set(key, group)
    setError('')
    void command('item', { ...target, turnId: item.webTurnId, itemId: item.id })
      .then((result) => {
        if (disposed) return
        let value = result.item
        revision.current = result.revision || 0
        for (const event of buffered)
          if (event.revision > revision.current) {
            value = applyDetail(value, event)
            revision.current = event.revision
          }
        hydrated = true
        setDetail(value)
      })
      .catch((error) => {
        if (!disposed) setError(error.message)
      })
    return () => {
      disposed = true
      group.delete(receive)
      if (!group.size) listeners.delete(key)
      void command('item/unwatch', { ...target, turnId: item.webTurnId, itemId: item.id }).catch(
        () => {}
      )
    }
  }, [target?.instanceId, target?.threadId, item.id, item.webTurnId, command, retry])
  if (error)
    return (
      <div className="lazy-notice" role="alert">
        {error}
        <button type="button" onClick={() => setRetry((value) => value + 1)}>
          重试
        </button>
      </div>
    )
  if (!detail)
    return (
      <div className="lazy-notice" role="status">
        正在加载详情…
      </div>
    )
  return (
    <>
      {(detail.webPartial || detail.webTruncated) && (
        <div className="lazy-notice">
          {detail.webPartial
            ? '运行中，仅显示最近缓存的输出；完成后可重新加载保存的结果。'
            : '内容过长，当前显示部分内容；完整记录保留在 Codex 中。'}
        </div>
      )}
      {render(detail)}
    </>
  )
}

export function LazyDetails({
  item,
  summary,
  render,
  className = 'tool'
}: {
  item: CodexRecord
  summary: ReactNode
  render: (detail: CodexRecord) => ReactNode
  className?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <details className={className} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{summary}</summary>
      {open && (item.webDeferred ? <DetailBody item={item} render={render} /> : render(item))}
    </details>
  )
}

export function DeferredSection({
  summary,
  children,
  className = 'tool'
}: {
  summary: ReactNode
  children: () => ReactNode
  className?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <details className={className} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{summary}</summary>
      {open && children()}
    </details>
  )
}

export function LazyDiff(): React.JSX.Element {
  const { target, command } = useContext(HistoryContext)
  const [result, setResult] = useState<CodexRecord>()
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false
    if (target)
      void command('diff', target)
        .then((value) => {
          if (!disposed) setResult(value)
        })
        .catch((error) => {
          if (!disposed) setError(error.message)
        })
    return () => {
      disposed = true
    }
  }, [target?.instanceId, target?.threadId, command])
  return error ? (
    <div className="lazy-notice">{error}</div>
  ) : !result ? (
    <div className="lazy-notice">正在加载修改…</div>
  ) : (
    <>
      {result.truncated && (
        <div className="lazy-notice">当前显示部分修改，完整记录保留在 Codex 中。</div>
      )}
      <pre>
        <LinkedText text={result.diff || '暂无修改'} />
      </pre>
    </>
  )
}
