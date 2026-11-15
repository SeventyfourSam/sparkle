import { createRoot } from 'react-dom/client'
import { memo, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  type CodexInstance,
  type CodexPendingRequest,
  type CodexRecord
} from '../../../../shared/codex-web'
import { useGateway } from './client'
import { DirectoryPicker } from './directory-picker'
import { SessionStatus } from './status-line'
import { ModelSettings } from './model-settings'
import { useComposerEditing } from './composer-editing'
import { usePageGestures } from './page-gestures'
import {
  ContentBase,
  ContentLink,
  ContentScope,
  LinkedPre,
  LinkedText,
  remarkContentLinks
} from './content-links'
import { FileView } from './file-view'
import { useHistoryWindow } from './history-window'
import { groupConversationItems } from './tool-groups'
import { codexWebCommands, parseCodexWebCommand } from '../../../../shared/codex-web-commands'
import {
  emptyConversation,
  mergeTurns,
  reduceEvent,
  trimWindow,
  statusLabel,
  type Conversation
} from './state'
import {
  DeferredSection,
  HistoryContext,
  LazyDetails,
  LazyDiff,
  publishDetail
} from './lazy-details'
import './style.css'

type Selection = { instanceId: string; threadId: string }
const time = (seconds?: number): string =>
  seconds
    ? new Date(seconds * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : ''
const runtimeName = (kind: string): string =>
  ({ embedded: '终端', shared: '共享后台', standalone: '独立服务' })[kind] || kind
const folder = (path = ''): string =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || path

function Icon({ name, size = 20 }: { name: string; size?: number }): React.JSX.Element {
  const paths: Record<string, ReactNode> = {
    arrow: <path d="m5 12 14 0m-6-6 6 6-6 6" />,
    back: <path d="m15 5-7 7 7 7" />,
    send: <path d="m5 12 7-7 7 7M12 5v14" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="3" />,
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M6 6a8 8 0 0 1 13 3M5 15a8 8 0 0 0 13 3" />
      </>
    ),
    terminal: (
      <>
        <path d="m6 8 4 4-4 4m7 0h5" />
        <rect x="2" y="3" width="20" height="18" rx="4" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 4 4" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    down: <path d="m6 9 6 6 6-6" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    plus: <path d="M12 5v14M5 12h14" />,
    spark: <path d="m12 2 2.8 7.2L22 12l-7.2 2.8L12 22l-2.8-7.2L2 12l7.2-2.8Z" />,
    folder: <path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10H3Z" />,
    sun: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1" />
      </>
    )
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.spark}
    </svg>
  )
}
const Mark = memo(function Mark({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm, remarkContentLinks]}
        urlTransform={(url) => url}
        components={{
          a: ({ children, href }) => <ContentLink href={href}>{children}</ContentLink>,
          pre: ({ children }) => <LinkedPre>{children}</LinkedPre>,
          img: ({ src, alt }) => (
            <ContentLink href={typeof src === 'string' ? src : undefined}>
              {alt || '图片'}
            </ContentLink>
          )
        }}
      >
        {children}
      </Markdown>
    </div>
  )
})
function Badge({ status }: { status?: CodexRecord }): React.JSX.Element {
  const label = statusLabel(status)
  return (
    <span className={`badge ${label.kind}`}>
      <i />
      {label.text}
    </span>
  )
}

const Item = memo(function Item({ item }: { item: CodexRecord }): React.JSX.Element | null {
  if (item.type === 'userMessage') {
    return (
      <div className="message user">
        <div className="message-label">你</div>
        {(item.content || []).map((input: CodexRecord, index: number) =>
          input.type === 'text' ? (
            <div key={index} className="user-text">
              <LinkedText text={input.text} />
            </div>
          ) : (
            <div key={index} className="attachment">
              {input.type === 'image' || input.type === 'localImage'
                ? '图片附件'
                : input.name || input.path || input.type}
            </div>
          )
        )}
        {item.webDeferred && (
          <LazyDetails
            item={item}
            summary="加载完整消息"
            render={(full) => (
              <pre>
                {full.content
                  ?.filter((entry: CodexRecord) => entry.type === 'text')
                  .map((entry: CodexRecord) => entry.text)
                  .join('\n')}
              </pre>
            )}
          />
        )}
      </div>
    )
  }
  if (item.type === 'agentMessage')
    return (
      <div className={`message assistant ${item.phase === 'commentary' ? 'commentary' : ''}`}>
        <div className="message-label">
          <Icon name="spark" size={14} />
          Codex{item.phase === 'commentary' && <span>进展</span>}
        </div>
        <Mark>{item.text || ''}</Mark>
        {item.webDeferred && (
          <LazyDetails
            item={item}
            summary="加载完整消息"
            render={(full) => <Mark>{full.text || ''}</Mark>}
          />
        )}
      </div>
    )
  if (item.type === 'reasoning') {
    return (
      <LazyDetails
        item={item}
        className="tool reasoning"
        summary={
          <>
            <span className="tool-symbol">◌</span>思考摘要
            <Icon name="down" size={14} />
          </>
        }
        render={(full) => (
          <Mark>{[...(full.summary || []), ...(full.content || [])].join('\n\n')}</Mark>
        )}
      />
    )
  }
  if (item.type === 'plan')
    return (
      <div className="message">
        <Mark>{item.text || ''}</Mark>
      </div>
    )
  if (item.type === 'contextCompaction') return <div className="timeline-note">上下文已压缩</div>
  const label: Record<string, string> = {
    commandExecution: '执行命令',
    fileChange: '文件修改',
    mcpToolCall: '工具调用',
    dynamicToolCall: '工具调用',
    collabAgentToolCall: '代理协作',
    subAgentActivity: '子代理',
    webSearch: '搜索网页',
    imageView: '查看图片',
    imageGeneration: '生成图片',
    hookPrompt: 'Hook',
    functionCallOutput: '工具结果'
  }
  const title =
    item.command ||
    (item.tool
      ? `${item.server ? `${item.server} / ` : ''}${item.tool}`
      : label[item.type] || item.type)
  const failed =
    item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0)
  return (
    <LazyDetails
      item={item}
      className={`tool ${failed ? 'failed' : ''}`}
      summary={
        <>
          <span className={`tool-symbol ${item.status === 'inProgress' ? 'spinning' : ''}`}>
            {failed ? '!' : item.status === 'inProgress' ? '◌' : '✓'}
          </span>
          <span className="tool-title">{title}</span>
          {item.durationMs != null && (
            <span className="tool-duration">{(item.durationMs / 1000).toFixed(1)}s</span>
          )}
          <Icon name="down" size={14} />
        </>
      }
      render={(full) => (
        <ContentBase cwd={full.cwd || item.cwd}>
          <ToolBody item={full} />
        </ContentBase>
      )}
    />
  )
})

function ToolBody({ item }: { item: CodexRecord }): React.JSX.Element {
  const result =
    item.aggregatedOutput || item.text || (typeof item.output === 'string' ? item.output : '')
  return (
    <>
      {item.cwd && (
        <div className="tool-meta">
          <ContentLink href={item.cwd}>{item.cwd}</ContentLink>
        </div>
      )}
      {result && (
        <pre>
          <LinkedText text={result} />
        </pre>
      )}
      {item.changes?.map((change: CodexRecord, index: number) => (
        <div className="file-change" key={index}>
          <div className="tool-meta">
            <ContentLink href={change.path}>{change.path}</ContentLink>
          </div>
          <pre>
            <LinkedText text={change.diff || JSON.stringify(change.kind)} />
          </pre>
        </div>
      ))}
      {!result && !item.changes && (
        <pre>
          <LinkedText text={JSON.stringify(item.result || item.arguments || item, null, 2)} />
        </pre>
      )}
    </>
  )
}

function RequestCard({
  request,
  respond,
  disabled
}: {
  request: CodexPendingRequest
  respond: (value: CodexRecord) => Promise<void>
  disabled: boolean
}): React.JSX.Element {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const questions: CodexRecord[] = request.params.questions || []
  const submit = async (value: CodexRecord): Promise<void> => {
    setBusy(true)
    try {
      await respond(value)
    } finally {
      setBusy(false)
    }
  }
  const locked = disabled || busy || request.responding
  return (
    <section className="request-card" aria-label="等待你的处理">
      <div className="request-heading">
        <span className="request-dot" />
        <strong>{questions.length ? 'Codex 需要你的回答' : '等待你的审批'}</strong>
        <span>待处理</span>
      </div>
      {request.params.reason && <p>{request.params.reason}</p>}
      {request.params.command && <pre>{request.params.command}</pre>}
      {request.params.cwd && <div className="tool-meta">{request.params.cwd}</div>}
      {request.params.grantRoot && <p>允许修改：{request.params.grantRoot}</p>}
      {request.method === 'item/permissions/requestApproval' && (
        <pre>{JSON.stringify(request.params.permissions, null, 2)}</pre>
      )}
      {questions.map((question) => (
        <fieldset key={question.id}>
          <legend>{question.question}</legend>
          <div className="question-options">
            {question.options?.map((option: CodexRecord) => (
              <label
                className={`question-option ${answers[question.id] === option.label ? 'selected' : ''}`}
                key={option.label}
              >
                <input
                  type="radio"
                  name={`${request.key}:${question.id}`}
                  value={option.label}
                  checked={answers[question.id] === option.label}
                  disabled={locked}
                  onChange={() => setAnswers({ ...answers, [question.id]: option.label })}
                />
                <span>
                  {option.label}
                  {option.description && <small>{option.description}</small>}
                </span>
              </label>
            ))}
          </div>
          <input
            type={question.isSecret ? 'password' : 'text'}
            aria-label={question.question}
            placeholder={question.options?.length ? '或输入其他回答' : '输入回答'}
            value={answers[question.id] || ''}
            disabled={locked}
            onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })}
          />
        </fieldset>
      ))}
      <div className="request-actions">
        {questions.length ? (
          <button
            className="button primary"
            disabled={locked || questions.some((q) => !answers[q.id]?.trim())}
            onClick={() => void submit({ answers })}
          >
            提交回答
            <Icon name="arrow" size={16} />
          </button>
        ) : (
          <>
            <button
              className="button secondary"
              disabled={locked}
              onClick={() => void submit({ decision: 'decline' })}
            >
              拒绝
            </button>
            <button
              className="button primary"
              disabled={locked}
              onClick={() => void submit({ decision: 'accept' })}
            >
              <Icon name="check" size={16} />
              允许本次
            </button>
          </>
        )}
        {request.responding && <span className="muted">正在同步结果…</span>}
      </div>
    </section>
  )
}

function ToolBatch({ items }: { items: CodexRecord[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [limit, setLimit] = useState(20)
  const failed = items.filter(
    (item) => item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0)
  ).length
  const running = items.some((item) => item.status === 'inProgress' || item.status === 'running')
  return (
    <details
      className="tool-group"
      onToggle={(event) => {
        setOpen(event.currentTarget.open)
        if (!event.currentTarget.open) setLimit(20)
      }}
    >
      <summary>
        <Icon name="terminal" size={16} />
        <span>工具调用与修改 · {items.length} 项</span>
        {!!failed && <small className="tool-group-error">{failed} 项失败</small>}
        {running && <small>进行中</small>}
        <Icon name="down" size={14} />
      </summary>
      {open && (
        <div className="tool-group-items">
          {items.slice(0, limit).map((item) => (
            <Item key={item.id} item={item} />
          ))}
          {limit < items.length && (
            <button
              className="load-older"
              onClick={() => setTimeout(() => setLimit((value) => value + 20), 0)}
            >
              加载更多操作
            </button>
          )}
        </div>
      )}
    </details>
  )
}

const ConversationItems = memo(function ConversationItems({
  turns
}: {
  turns: CodexRecord[]
}): React.JSX.Element {
  return (
    <>
      {groupConversationItems(turns).map((group) => {
        if (group.error)
          return (
            <div className="inline-error" key={group.id}>
              {group.error}
            </div>
          )
        if (group.interrupted)
          return (
            <div className="timeline-note" key={group.id}>
              任务已停止，可以继续发消息
            </div>
          )
        if (!group.tools)
          return (
            <div key={group.id} data-history-id={group.id}>
              <Item item={group.items[0]} />
            </div>
          )
        return (
          <div key={group.id} data-history-id={group.id}>
            <ToolBatch items={group.items} />
          </div>
        )
      })}
    </>
  )
})

function App(): React.JSX.Element {
  usePageGestures()
  const composerEditing = useComposerEditing()
  const [instances, setInstances] = useState<CodexInstance[]>([])
  const [requests, setRequests] = useState<Record<string, CodexPendingRequest[]>>({})
  const [selection, setSelection] = useState<Selection>()
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const [conversation, setConversation] = useState(emptyConversation)
  const [draft, setDraft] = useState('')
  const draftRef = useRef(draft)
  draftRef.current = draft
  const drafts = useRef(new Map<string, string>())
  const [busy, setBusy] = useState(false)
  const [showScrollBottom, setShowScrollBottom] = useState(false)
  const [statusExpanded, setStatusExpanded] = useState(false)
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false)
  const [showCommandHelp, setShowCommandHelp] = useState(false)
  const [dismissCommandSuggestions, setDismissCommandSuggestions] = useState(false)
  const [commandError, setCommandError] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const [newInstance, setNewInstance] = useState('')
  const [newCwd, setNewCwd] = useState('')
  const [choosingDirectory, setChoosingDirectory] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [syncVersion, setSyncVersion] = useState(0)
  const [toast, setToast] = useState('')
  const [theme, setTheme] = useState(() => localStorage.getItem('codex-theme') || 'dark')
  const scroller = useRef<HTMLDivElement>(null)
  const serversDialog = useRef<HTMLDialogElement>(null)
  const createDialog = useRef<HTMLDialogElement>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const hydrating = useRef(true)
  const events = useRef<CodexRecord[]>([])
  const { connected, command } = useGateway((message) => {
    if (message.type === 'error') setToast(message.error)
    if (message.type === 'instances') setInstances(message.instances)
    if (message.type === 'requests')
      setRequests((old) => ({ ...old, [message.instanceId]: message.requests }))
    const selected = selectionRef.current
    if (message.type === 'events') {
      const eventsForThread = message.events.filter((event: CodexRecord) => {
        if (
          !selected ||
          event.instanceId !== selected.instanceId ||
          (event.threadId && event.threadId !== selected.threadId) ||
          (event.params?.threadId && event.params.threadId !== selected.threadId)
        )
          return false
        if (event.type === 'detail') {
          publishDetail(event)
          return false
        }
        return true
      })
      if (hydrating.current) events.current.push(...eventsForThread)
      else if (eventsForThread.length)
        setConversation((old) =>
          eventsForThread.reduce(
            (value: Conversation, event: CodexRecord) =>
              reduceEvent(value, event.method, event.params),
            old
          )
        )
      return
    }
    if (!selected || message.instanceId !== selected.instanceId) return
    if (message.type === 'history' && message.threadId === selected.threadId) {
      hydrating.current = false
      setConversation((old) => {
        let next: Conversation = {
          ...old,
          thread: message.thread,
          turns: message.turns,
          nextCursor: message.olderCursor ?? message.nextCursor,
          newerCursor: message.newerCursor,
          activeTurn: message.activeTurn,
          tokenUsage: message.tokenUsage,
          goal: message.goal,
          rateLimits: message.rateLimits,
          plan: message.plan,
          diffAvailable: message.diffAvailable,
          historyNotice: message.historyNotice,
          browsingHistory: false,
          windowTrimmed: false,
          loading: false,
          subscribed: true,
          error: undefined
        }
        // Full item completions supersede snapshots; deltas already represented in history must not be appended twice.
        for (const event of events.current)
          if (!event.method.endsWith('Delta') && !event.method.endsWith('/delta'))
            next = reduceEvent(next, event.method, event.params)
        events.current = []
        return trimWindow(next)
      })
      return
    }
    if (message.type === 'event') {
      if (message.params.threadId && message.params.threadId !== selected.threadId) return
      if (hydrating.current) events.current.push(message)
      else setConversation((old) => reduceEvent(old, message.method, message.params))
    }
    if (message.type === 'error') setToast(message.error)
  })
  const historyWindow = useHistoryWindow({
    conversation,
    target: selection,
    command,
    scroller,
    nearBottom,
    online: connected && !!instances.find((item) => item.id === selection?.instanceId)?.ready,
    adoptLatest: (turns) =>
      setConversation((old) => trimWindow({ ...old, turns: mergeTurns(turns, old.turns) }))
  })
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('codex-theme', theme)
  }, [theme])
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(''), 7000)
    return () => clearTimeout(timer)
  }, [toast])
  useEffect(() => {
    if (!selection || !connected) return
    hydrating.current = true
    events.current = []
    nearBottom.current = true
    setShowScrollBottom(false)
    setCommandError('')
    setConversation(emptyConversation())
    const target = selection
    void command('watch', target).catch((error) => {
      if (selectionRef.current === target) {
        const message = /no rollout found/i.test(error.message)
          ? '这个会话暂时还没有可读取的历史。首次产生消息后，可以重新同步。'
          : error.message
        setConversation((old) => ({ ...old, loading: false, subscribed: false, error: message }))
        setToast(message)
      }
    })
  }, [selection, connected, command, syncVersion])
  useEffect(() => {
    const node = scroller.current
    if (nearBottom.current && node) node.scrollTop = node.scrollHeight
  }, [conversation.turns, conversation.loading, requests])
  useEffect(() => {
    const node = scroller.current
    const content = node?.firstElementChild
    if (!node || !content) return
    const observer = new ResizeObserver(() => {
      if (nearBottom.current) node.scrollTop = node.scrollHeight
      nearBottom.current =
        !historyWindow.browsing && node.scrollHeight - node.scrollTop - node.clientHeight < 160
      setShowScrollBottom(!nearBottom.current)
    })
    observer.observe(node)
    observer.observe(content)
    return () => observer.disconnect()
  }, [selection, historyWindow.browsing])
  useEffect(() => {
    if (!createDialog.current?.open) return
    if (!instances.some((item) => item.ready && item.id === newInstance)) {
      setNewInstance(instances.find((item) => item.ready)?.id || '')
    }
  }, [instances, newInstance])

  const instance = instances.find((item) => item.id === selection?.instanceId)
  const metadata = instance?.threads.find((thread) => thread.id === selection?.threadId)
  const thread = conversation.thread || metadata
  const activeTurn =
    conversation.activeTurn || conversation.turns.findLast((turn) => turn.status === 'inProgress')
  const pending = selection
    ? (requests[selection.instanceId] || []).filter(
        (request) => request.params.threadId === selection.threadId
      )
    : []
  const online = connected && !!instance?.ready
  const allThreads = instances.flatMap((item) =>
    item.threads.map((entry) => ({ thread: entry, instance: item }))
  )
  const visible = allThreads.sort((a, b) => (b.thread.updatedAt || 0) - (a.thread.updatedAt || 0))

  const select = (next: Selection): void => {
    if (selection) drafts.current.set(`${selection.instanceId}:${selection.threadId}`, draft)
    setDraft(drafts.current.get(`${next.instanceId}:${next.threadId}`) || '')
    setSelection(next)
  }
  const openCreate = (): void => {
    const available = instances.filter((item) => item.ready)
    setNewInstance(
      available.find((item) => item.id === selection?.instanceId)?.id || available[0]?.id || ''
    )
    setNewCwd('')
    setCreateError('')
    setChoosingDirectory(true)
    setCreateOpen(true)
    createDialog.current?.showModal()
  }
  const create = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!connected || !newInstance || !newCwd || creating) return
    const instanceId = newInstance
    setCreating(true)
    setCreateError('')
    try {
      const result = await command('create', { instanceId, cwd: newCwd })
      select({ instanceId, threadId: result.thread.id })
      createDialog.current?.close()
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error))
    } finally {
      setCreating(false)
    }
  }
  const back = (): void => {
    if (selection) drafts.current.set(`${selection.instanceId}:${selection.threadId}`, draft)
    setSelection(undefined)
    void command('unwatch').catch(() => {})
  }
  const send = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!selection || !draft.trim() || busy) return
    const text = draft
    const target = selection
    setBusy(true)
    setCommandError('')
    try {
      const parsed = parseCodexWebCommand(text)
      if (
        parsed?.name === 'help' ||
        parsed?.name === 'status' ||
        parsed?.name === 'model' ||
        parsed?.name === 'reasoning'
      ) {
        if (parsed.name === 'help') setShowCommandHelp(true)
        else if (parsed.name === 'status') setStatusExpanded(true)
        else setModelSettingsOpen(true)
        drafts.current.delete(`${target.instanceId}:${target.threadId}`)
        setDraft('')
        return
      }
      const result = await command('send', { ...target, text, turnId: activeTurn?.id })
      drafts.current.delete(`${target.instanceId}:${target.threadId}`)
      if (selectionRef.current === target) {
        if (draftRef.current === text) {
          setDraft('')
          composerEditing.finish()
        }
        nearBottom.current = true
        if (!result.webCommand) historyWindow.latest()
        if (result.turn)
          setConversation((old) => reduceEvent(old, 'turn/started', { turn: result.turn }))
        if (result.webCommand?.name === 'goal') setStatusExpanded(true)
        if (result.webCommand?.name === 'compact') setToast('已请求压缩会话上下文')
      }
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const scrollToBottom = (): void => {
    nearBottom.current = true
    setShowScrollBottom(false)
    historyWindow.latest()
  }
  const interrupt = async (): Promise<void> => {
    if (!selection || !activeTurn) return
    setBusy(true)
    try {
      await command('interrupt', { ...selection, turnId: activeTurn.id })
    } catch (error) {
      setToast(String(error))
    } finally {
      setBusy(false)
    }
  }
  const historyContext = useMemo(() => ({ target: selection, command }), [selection, command])
  const linkScope = useMemo(
    () => (selection ? { ...selection, cwd: thread?.cwd || metadata?.cwd } : undefined),
    [selection, thread?.cwd, metadata?.cwd]
  )
  const composerExpanded =
    composerEditing.editing ||
    statusExpanded ||
    modelSettingsOpen ||
    showCommandHelp ||
    !!commandError
  return (
    <ContentScope.Provider value={linkScope}>
      <HistoryContext.Provider value={historyContext}>
        <div className={`app ${selection ? 'has-selection' : ''}`}>
          <aside className="sidebar">
            <header className="sidebar-create">
              <button className="new-session-button" disabled={!connected} onClick={openCreate}>
                <Icon name="plus" size={17} />
                新建会话
              </button>
            </header>
            <div className="thread-list">
              {!visible.length && (
                <div className="empty-list">
                  <Icon name="terminal" size={32} />
                  <h3>等待 Codex 接入</h3>
                  <p>
                    在 Codex 中手动配置本机接入端口后，重启对应的
                    Codex。连接成功的会话会自动显示在这里。
                  </p>
                </div>
              )}
              {visible.map(({ thread, instance }) => (
                <button
                  className={`thread-card ${selection?.instanceId === instance.id && selection.threadId === thread.id ? 'selected' : ''}`}
                  key={`${instance.id}:${thread.id}`}
                  onClick={() => select({ instanceId: instance.id, threadId: thread.id })}
                >
                  <div className="thread-card-top">
                    <span className="project">
                      <Icon name="folder" size={13} />
                      {folder(thread.cwd)}
                    </span>
                    <time>{time(thread.updatedAt)}</time>
                  </div>
                  <h2>{thread.name || thread.preview || '未命名会话'}</h2>
                  <p>{thread.preview || thread.cwd}</p>
                  <div className="thread-card-bottom">
                    <Badge status={instance.ready ? thread.status : { type: 'offline' }} />
                    <span>
                      {runtimeName(instance.runtime)} · {instance.pid}
                    </span>
                  </div>
                </button>
              ))}
            </div>
            <footer className="sidebar-footer">
              <button
                className="icon-button"
                aria-label="切换明暗主题"
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              >
                <Icon name="sun" size={16} />
              </button>
              <span className={`connection ${connected ? 'online' : ''}`}>
                <i />
                {connected ? '已连接 Sparkle' : '正在重新连接…'}
              </span>
              <button className="servers-button" onClick={() => serversDialog.current?.showModal()}>
                {instances.filter((item) => item.ready).length} 个服务
                <Icon name="arrow" size={12} />
              </button>
            </footer>
          </aside>
          <main className="conversation">
            {!selection ? (
              <div className="welcome">
                <div className="welcome-symbol">
                  <Icon name="spark" size={38} />
                </div>
                <span className="eyebrow">CODEX, WITHIN REACH</span>
                <h2>随时接着做。</h2>
                <p>
                  查看进展，给出下一步指令。
                  <br />
                  从左侧选择一个会话开始。
                </p>
                <div className="welcome-hint">
                  <span className="live-dot" />
                  与终端里的 Codex 实时同步
                </div>
              </div>
            ) : (
              <>
                <header className="chat-header">
                  <button
                    className="icon-button back-button"
                    aria-label="返回会话列表"
                    onClick={back}
                  >
                    <Icon name="back" />
                  </button>
                  <div className="chat-title">
                    <h1>{metadata?.name || thread?.name || metadata?.preview || 'Codex 会话'}</h1>
                    <div>
                      <span>{folder(thread?.cwd || metadata?.cwd)}</span>
                      <span>·</span>
                      <span>
                        {runtimeName(instance?.runtime || '')} {instance?.pid}
                      </span>
                    </div>
                  </div>
                  <Badge
                    status={online ? metadata?.status || thread?.status : { type: 'offline' }}
                  />
                </header>
                {!!pending.length && (
                  <button className="pending-banner" onClick={scrollToBottom}>
                    <span className="request-dot" />有 {pending.length} 项等待你的处理
                    <Icon name="down" size={14} />
                  </button>
                )}
                {!online && (
                  <div className="connection-banner" role="status">
                    {connected
                      ? 'app-server 已离线，等待自动重连。'
                      : '与 Sparkle 的连接已断开，正在重连。'}
                    你的输入会保留。
                  </div>
                )}
                <div className="message-viewport">
                  <div
                    className="message-scroller"
                    ref={scroller}
                    onClickCapture={(event) => {
                      const summary = (event.target as HTMLElement).closest('summary')
                      if (
                        summary?.parentElement instanceof HTMLDetailsElement &&
                        !summary.parentElement.open
                      )
                        nearBottom.current = false
                    }}
                    onScroll={() => {
                      const node = scroller.current
                      if (node) {
                        nearBottom.current =
                          !historyWindow.browsing &&
                          node.scrollHeight - node.scrollTop - node.clientHeight < 160
                        setShowScrollBottom(!nearBottom.current)
                      }
                    }}
                  >
                    <div className="messages">
                      <div className="session-intro">
                        <Icon name="terminal" size={18} />
                        <span>{thread?.cwd || metadata?.cwd}</span>
                      </div>
                      {conversation.historyNotice && (
                        <div className="lazy-notice">{conversation.historyNotice}</div>
                      )}
                      <div className="history-edge" aria-live="polite">
                        {historyWindow.loading ? (
                          '正在加载历史…'
                        ) : historyWindow.error ? (
                          <button onClick={historyWindow.older}>加载失败，点击重试</button>
                        ) : historyWindow.hasOlder ? (
                          '上滑查看更早的消息'
                        ) : (
                          '已到最早的消息'
                        )}
                      </div>
                      {conversation.loading ? (
                        <div className="loading">
                          <span className="loading-dot" />
                          正在同步会话…
                        </div>
                      ) : (
                        <>
                          {!historyWindow.turns.length && !conversation.error && (
                            <div className="chat-empty">
                              <Icon name="spark" size={28} />
                              <h2>准备就绪</h2>
                              <p>发一条消息，继续这段会话。</p>
                            </div>
                          )}
                          <div data-history-spacer="top" aria-hidden="true" />
                          <ConversationItems turns={historyWindow.turns} />
                          <div data-history-spacer="bottom" aria-hidden="true" />
                          {conversation.plan && (
                            <DeferredSection
                              className="tool plan"
                              summary={
                                <>
                                  <Icon name="check" size={16} />
                                  工作计划
                                  <Icon name="down" size={14} />
                                </>
                              }
                            >
                              {() =>
                                conversation.plan!.map((step, index) => (
                                  <div className={`plan-step ${step.status}`} key={index}>
                                    <span>
                                      {step.status === 'completed'
                                        ? '✓'
                                        : step.status === 'inProgress'
                                          ? '◌'
                                          : '○'}
                                    </span>
                                    <LinkedText text={step.step} />
                                  </div>
                                ))
                              }
                            </DeferredSection>
                          )}
                          {conversation.diffAvailable && (
                            <DeferredSection
                              summary={
                                <>
                                  本轮代码修改
                                  <Icon name="down" size={14} />
                                </>
                              }
                            >
                              {() => <LazyDiff />}
                            </DeferredSection>
                          )}
                          {pending.map((request) => (
                            <RequestCard
                              key={request.key}
                              request={request}
                              disabled={!online}
                              respond={async (value) => {
                                try {
                                  await command('respond', {
                                    instanceId: selection.instanceId,
                                    key: request.key,
                                    ...value
                                  })
                                } catch (error) {
                                  setToast(String(error))
                                }
                              }}
                            />
                          ))}
                          {activeTurn && !pending.length && (
                            <div className="working">
                              <span className="loading-dot" />
                              Codex 正在工作
                              <span className="working-bars">
                                <i />
                                <i />
                                <i />
                              </span>
                            </div>
                          )}
                          {conversation.error && (
                            <div className="inline-error" role="alert">
                              {conversation.error}
                              <button
                                className="button secondary retry-button"
                                disabled={!online}
                                onClick={() => setSyncVersion((value) => value + 1)}
                              >
                                重新同步会话
                              </button>
                            </div>
                          )}
                        </>
                      )}
                      <div ref={bottom} />
                    </div>
                  </div>
                  {(showScrollBottom || historyWindow.browsing) && (
                    <button
                      type="button"
                      className="scroll-to-bottom"
                      aria-label="回到底部"
                      onClick={scrollToBottom}
                    >
                      <Icon name="down" size={17} />
                    </button>
                  )}
                </div>
                <div
                  ref={composerEditing.ref}
                  className={`composer-wrap ${composerExpanded ? '' : 'is-compact'}`}
                >
                  <SessionStatus
                    thread={{ ...metadata, ...thread }}
                    conversation={conversation}
                    expanded={statusExpanded}
                    onToggle={() => setStatusExpanded((value) => !value)}
                    onEditSettings={() => setModelSettingsOpen(true)}
                    settingsDisabled={!online || conversation.loading || !conversation.subscribed}
                  />
                  {(showCommandHelp ||
                    (!dismissCommandSuggestions && /^\/[a-z-]*$/i.test(draft.trim()))) && (
                    <div className="command-help" aria-label="网页命令">
                      <div className="command-help-heading">
                        <span>网页命令</span>
                        <button
                          type="button"
                          onClick={() => {
                            setShowCommandHelp(false)
                            setDismissCommandSuggestions(true)
                          }}
                          aria-label="关闭命令帮助"
                        >
                          ×
                        </button>
                      </div>
                      {codexWebCommands
                        .filter(
                          (item) =>
                            showCommandHelp ||
                            item.name.startsWith(draft.trim().slice(1).toLowerCase())
                        )
                        .map((item) => (
                          <button
                            type="button"
                            key={item.name}
                            onClick={() => {
                              setDraft(`/${item.name}${item.name === 'goal' ? ' ' : ''}`)
                              setShowCommandHelp(false)
                              setDismissCommandSuggestions(true)
                              setCommandError('')
                            }}
                          >
                            <strong>/{item.name}</strong>
                            <span>{showCommandHelp ? item.usage : item.description}</span>
                          </button>
                        ))}
                      {showCommandHelp && <p>/side 暂需 Codex 提供旁支会话接口。</p>}
                    </div>
                  )}
                  {commandError && (
                    <div className="command-error" role="alert">
                      {commandError}
                    </div>
                  )}
                  <form
                    className={`composer ${!online ? 'disabled' : ''}`}
                    onSubmit={(event) => void send(event)}
                  >
                    <textarea
                      aria-label="发送给 Codex 的消息"
                      placeholder={
                        !composerExpanded
                          ? '发消息…'
                          : activeTurn
                            ? '追加指令，不打断当前任务…'
                            : '给 Codex 发消息…'
                      }
                      onFocus={(event) => {
                        const node = event.currentTarget
                        requestAnimationFrame(() => {
                          node.style.height = 'auto'
                          node.style.height = `${Math.min(node.scrollHeight, 160)}px`
                        })
                      }}
                      rows={1}
                      value={draft}
                      onChange={(event) => {
                        setDraft(event.target.value)
                        setCommandError('')
                        setDismissCommandSuggestions(false)
                        event.target.style.height = 'auto'
                        event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`
                      }}
                      onKeyDown={(event) => {
                        if (
                          event.key === 'Enter' &&
                          (event.ctrlKey || event.metaKey) &&
                          !event.nativeEvent.isComposing
                        ) {
                          event.preventDefault()
                          void send(event)
                        }
                      }}
                    />
                    <div className="composer-bottom">
                      <span>
                        {activeTurn ? '追加到当前任务' : '新的消息'}
                        <span className="desktop-hint"> · Ctrl ↵ 发送</span>
                        <button
                          type="button"
                          className="command-help-button"
                          onClick={() => setShowCommandHelp((value) => !value)}
                        >
                          {' '}
                          / 命令
                        </button>
                      </span>
                      <div className="composer-buttons">
                        {activeTurn && (
                          <button
                            type="button"
                            className="stop-button"
                            aria-label="停止当前任务"
                            disabled={!online || busy}
                            onClick={() => void interrupt()}
                          >
                            <Icon name="stop" size={17} />
                            停止
                          </button>
                        )}
                        <button
                          className="send-button"
                          aria-label={activeTurn ? '追加指令' : '发送消息'}
                          disabled={
                            !online ||
                            busy ||
                            !draft.trim() ||
                            conversation.loading ||
                            !conversation.subscribed
                          }
                        >
                          <Icon name="send" size={21} />
                        </button>
                      </div>
                    </div>
                  </form>
                </div>
              </>
            )}
          </main>
          {modelSettingsOpen && selection && thread && (
            <ModelSettings
              key={`${selection.instanceId}:${selection.threadId}`}
              command={command}
              instanceId={selection.instanceId}
              thread={{ ...metadata, ...thread }}
              online={online}
              onClose={() => setModelSettingsOpen(false)}
              onSaved={() => setToast('已保存模型与推理强度，将用于后续任务')}
            />
          )}
          <dialog
            ref={createDialog}
            aria-label="新建会话"
            className="create-dialog"
            onClose={() => setCreateOpen(false)}
            onCancel={(event) => {
              if (creating) event.preventDefault()
            }}
            onClick={(event) => {
              if (!creating && event.target === event.currentTarget) createDialog.current?.close()
            }}
          >
            {choosingDirectory && createOpen ? (
              <DirectoryPicker
                command={command}
                initialPath={newCwd}
                recent={[
                  ...new Set(
                    instances.flatMap((item) =>
                      item.threads
                        .map((thread) => thread.cwd)
                        .filter((path): path is string => typeof path === 'string' && !!path)
                    )
                  )
                ]}
                onSelect={(path) => {
                  setNewCwd(path)
                  setCreateError('')
                  setChoosingDirectory(false)
                }}
                onCancel={() => createDialog.current?.close()}
              />
            ) : !choosingDirectory && createOpen ? (
              <form onSubmit={(event) => void create(event)}>
                <div className="create-heading">
                  <div>
                    <span className="eyebrow">NEW SESSION</span>
                    <h2>新建会话</h2>
                  </div>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="关闭新建会话"
                    disabled={creating}
                    onClick={() => createDialog.current?.close()}
                  >
                    <Icon name="close" />
                  </button>
                </div>
                <div className="create-field">
                  工作目录
                  <button
                    type="button"
                    className="selected-directory"
                    disabled={creating}
                    onClick={() => setChoosingDirectory(true)}
                  >
                    <Icon name="folder" size={19} />
                    <span>{newCwd}</span>
                    <strong>更换</strong>
                  </button>
                </div>
                <label className="create-field">
                  Codex 服务
                  <select
                    aria-label="Codex 服务"
                    value={newInstance}
                    disabled={creating || !instances.some((item) => item.ready)}
                    onChange={(event) => setNewInstance(event.target.value)}
                  >
                    {!instances.some((item) => item.ready) && (
                      <option value="">等待 Codex 接入</option>
                    )}
                    {instances
                      .filter((item) => item.ready)
                      .map((item) => (
                        <option value={item.id} key={item.id}>
                          {runtimeName(item.runtime)} · PID {item.pid}
                        </option>
                      ))}
                  </select>
                </label>
                {!instances.some((item) => item.ready) && (
                  <p className="create-note">请先启动已连接 Sparkle 的 Codex，再创建会话。</p>
                )}
                {createError && (
                  <p className="create-error" role="alert">
                    {createError}
                  </p>
                )}
                <div className="create-actions">
                  <button
                    type="button"
                    className="button secondary"
                    disabled={creating}
                    onClick={() => createDialog.current?.close()}
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    className="button primary"
                    disabled={
                      !connected ||
                      creating ||
                      !newCwd ||
                      !instances.some((item) => item.ready && item.id === newInstance)
                    }
                  >
                    {creating ? '正在创建…' : '创建会话'}
                    <Icon name="arrow" size={16} />
                  </button>
                </div>
              </form>
            ) : null}
          </dialog>
          <dialog
            ref={serversDialog}
            aria-label="app-server 服务实例"
            className="servers-dialog"
            onClick={(event) => {
              if (event.target === event.currentTarget) serversDialog.current?.close()
            }}
          >
            <div className="servers-heading">
              <div>
                <span className="eyebrow">APP SERVERS</span>
                <h2>已接入的服务</h2>
              </div>
              <form method="dialog">
                <button className="icon-button" aria-label="关闭服务列表">
                  <Icon name="close" />
                </button>
              </form>
            </div>
            {!instances.length && (
              <p className="muted">
                尚无 app-server 接入。启用连接配置后，需要重启已运行的 Codex。
              </p>
            )}
            {instances.map((item) => (
              <div className="server-row" key={item.id}>
                <div className="server-row-title">
                  <Icon name="terminal" size={18} />
                  <strong>{runtimeName(item.runtime)}</strong>
                  <span className={`connection ${item.ready ? 'online' : ''}`}>
                    <i />
                    {item.ready ? '已连接' : item.connected ? '初始化中' : '离线'}
                  </span>
                </div>
                <p>
                  PID {item.pid} · {item.threads.length} 个会话
                </p>
                <code>{item.id}</code>
                {item.error && <p className="server-error">{item.error}</p>}
              </div>
            ))}
          </dialog>
          {toast && (
            <div className="toast" role="alert">
              <span>{toast}</span>
              <button className="icon-button" aria-label="关闭提示" onClick={() => setToast('')}>
                <Icon name="close" size={16} />
              </button>
            </div>
          )}
        </div>
      </HistoryContext.Provider>
    </ContentScope.Provider>
  )
}

document.documentElement.dataset.theme = localStorage.getItem('codex-theme') || 'dark'
createRoot(document.getElementById('root')!).render(
  location.pathname === '/codex/file' ? <FileView /> : <App />
)
