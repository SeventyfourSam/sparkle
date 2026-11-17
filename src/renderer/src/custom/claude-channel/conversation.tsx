import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  ClaudeChannelSession,
  ClaudeMessage,
  ClaudePermission
} from '../../../../shared/claude-channel'
import { claudeMessageWindow, isClaudeMessage } from '../../../../shared/claude-channel'
import type { CodexRecord } from '../../../../shared/codex-web'
import { useComposerEditing } from '../codex-web/composer-editing'
import { useClaudeHistory } from './history-window'
import { StartupTerminal } from './terminal'
import {
  ContentScope,
  ContentBase,
  ContentLink,
  LinkedPre,
  remarkContentLinks
} from '../codex-web/content-links'
import { contentHref } from '../../../../shared/codex-web-links'
import { CopyMessage } from '../copy-message'
import { Activity } from './activity'
import { claudeStateLabels as labels, type ClaudeChannel } from './channel'
import './style.css'

const uuid = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
function Message({
  message,
  command,
  sessionId
}: {
  message: ClaudeMessage
  command: ClaudeChannel['command']
  sessionId: string
}): React.JSX.Element {
  return (
    <article className={`claude-message ${message.role}`} data-claude-message={message.id}>
      <div className="claude-message-label">
        <span>{message.role === 'user' ? '你' : 'Claude'}</span>
        {message.role === 'assistant' && (
          <CopyMessage
            text={message.text}
            load={
              message.truncated && message.source
                ? async () => {
                    const result = await command('historyDetail', {
                      sessionId,
                      source: message.source
                    })
                    return result.items[0]?.text || message.text
                  }
                : undefined
            }
          />
        )}
      </div>
      <Markdown
        remarkPlugins={[remarkGfm, remarkContentLinks]}
        urlTransform={(url) => url}
        components={{
          a: ({ href, children }) => <ContentLink href={href}>{children}</ContentLink>,
          pre: ({ children }) => <LinkedPre>{children}</LinkedPre>
        }}
      >
        {message.text}
      </Markdown>
      {(message.hasTools || message.detail) && (
        <Activity items={[message]} command={command} sessionId={sessionId} />
      )}
      {message.state && (
        <small>
          {
            {
              sending: '正在提交…',
              submitted: '已提交通道 · 等待 Claude 处理',
              replied: 'Claude 已回复',
              failed: '发送未确认 · 请检查原终端，避免重复发送'
            }[message.state]
          }
        </small>
      )}
    </article>
  )
}
function Messages({
  items,
  command,
  sessionId
}: {
  items: ClaudeMessage[]
  command: ClaudeChannel['command']
  sessionId: string
}): React.JSX.Element {
  const groups: (ClaudeMessage | ClaudeMessage[])[] = []
  for (const item of items) {
    const last = groups.at(-1)
    if (item.role === 'tool') {
      if (Array.isArray(last)) last.push(item)
      else groups.push([item])
    } else groups.push(item)
  }
  return (
    <>
      {groups.map((group) =>
        Array.isArray(group) ? (
          <Activity key={group[0].id} items={group} command={command} sessionId={sessionId} />
        ) : (
          <ContentBase key={group.id} cwd={group.cwd}>
            <Message message={group} command={command} sessionId={sessionId} />
          </ContentBase>
        )
      )}
    </>
  )
}

export default function ClaudeConversation({
  channel,
  sessionId,
  initialTerminal,
  onBack
}: {
  channel: ClaudeChannel
  sessionId: string
  initialTerminal?: boolean
  onBack: () => void
}): React.JSX.Element {
  const { command, connected, subscribe, drafts } = channel
  const [loaded, setLoaded] = useState<ClaudeChannelSession>()
  const session =
    channel.sessions.find((item) => item.id === sessionId) ||
    loaded ||
    ({
      id: sessionId,
      title: 'Claude 会话',
      cwd: '',
      connected: false,
      owned: !!initialTerminal,
      terminal: !!initialTerminal,
      state: 'starting',
      createdAt: Date.now()
    } as ClaudeChannelSession)
  const [permissions, setPermissions] = useState<ClaudePermission[]>([])
  const [stream, setStream] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [draft, setDraft] = useState(() => drafts.current.get(sessionId)?.text || '')
  const [terminal, setTerminal] = useState(!!initialTerminal)
  const [pendingVerdict, setPendingVerdict] = useState('')
  const messageId = useRef(drafts.current.get(sessionId)?.messageId)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const active = useRef(true)
  const terminalListener = useRef<(text: string) => void>(() => {})
  const listen = useCallback((callback: (text: string) => void) => {
    terminalListener.current = callback
    return () => {
      if (terminalListener.current === callback) terminalListener.current = () => {}
    }
  }, [])
  const history = useClaudeHistory(sessionId, command)
  const composer = useComposerEditing()
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      drafts.current.set(sessionId, { text: draftRef.current, messageId: messageId.current })
      while (drafts.current.size > 64) drafts.current.delete(drafts.current.keys().next().value!)
    }
  }, [drafts, sessionId])
  useEffect(() => {
    if (!connected) return
    let disposed = false
    void command('watch', { sessionId })
      .then((result) => {
        if (disposed) return
        setLoaded(result.session)
        setPermissions(result.permissions || [])
        setStream(result.stream || '')
        void history.latest()
      })
      .catch((error) => {
        if (!disposed) setError(error.message)
      })
    return () => {
      disposed = true
      clearTimeout(refreshTimer.current)
      void command('unwatch').catch(() => {})
    }
  }, [sessionId, connected, command, history.latest])
  const handler = useRef<(message: CodexRecord) => void>(() => {})
  handler.current = (message) => {
    if (message.type === 'sessions') {
      if (
        !message.sessions.some(
          (item: ClaudeChannelSession) => item.id === sessionId && item.connected
        )
      )
        setPermissions([])
      return
    }
    if (message.sessionId !== sessionId) return
    if (message.type === 'message') history.receive(message.message)
    else if (message.type === 'permissions') setPermissions(message.permissions)
    else if (message.type === 'stream') setStream(message.text)
    else if (message.type === 'terminal') terminalListener.current(message.data)
    else if (message.type === 'reset') {
      setPermissions([])
      setStream('')
      void history.latest()
    } else if (message.type === 'changed') {
      clearTimeout(refreshTimer.current)
      refreshTimer.current = setTimeout(() => void history.refresh(), 600)
    }
  }
  useEffect(() => subscribe((message) => handler.current(message)), [subscribe])
  const act = async (action: string, params: CodexRecord = {}): Promise<void> => {
    try {
      setError('')
      await command(action, { sessionId, nativeId: session.nativeId, ...params })
    } catch (error) {
      setError((error as Error).message)
    }
  }
  const send = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const text = draft.trim()
    if (!text || sending) return
    if (/^\/[a-z]/i.test(text)) {
      setError('Channel 不执行原生命令，请在电脑终端使用；发送普通消息可直接输入文字。')
      return
    }
    if (messageId.current?.text !== text) messageId.current = { text, id: uuid() }
    setSending(true)
    setError('')
    try {
      await command('send', {
        sessionId,
        nativeId: session.nativeId,
        messageId: messageId.current.id,
        text
      })
      const saved = drafts.current.get(sessionId)
      if (saved?.text.trim() === text) drafts.current.set(sessionId, { text: '' })
      if (active.current) {
        setDraft((value) => (value.trim() === text ? '' : value))
        messageId.current = undefined
        void history.latest()
      }
    } catch (error) {
      if (active.current) setError((error as Error).message)
    } finally {
      if (active.current) setSending(false)
    }
  }
  const streamStart = claudeMessageWindow(
    history.items,
    19,
    Math.max(0, history.items.filter(isClaudeMessage).length - 19)
  )[0]
  return (
    <ContentScope.Provider value={{ sessionId, nativeId: session.nativeId, cwd: session.cwd }}>
      <section className="claude-view" aria-label="Claude 会话">
        {session ? (
          <>
            <header className="claude-heading">
              <button onClick={onBack} aria-label="返回会话列表">
                ‹
              </button>
              <div>
                <strong>{session.title}</strong>
                <small>
                  {connected ? labels[session.state] : '网页正在重连'}
                  {session.model ? ` · ${session.model}` : ''}
                </small>
              </div>
              {session.owned && (
                <button onClick={() => setTerminal((value) => !value)}>
                  {terminal ? '关闭终端' : '终端'}
                </button>
              )}
              {session.cwd && (
                <a
                  className="claude-project-folder"
                  aria-label="打开项目目录"
                  title="打开项目目录"
                  href={contentHref('./', {
                    sessionId,
                    nativeId: session.nativeId,
                    cwd: session.cwd
                  })}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <svg
                    width="19"
                    height="19"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                  >
                    <path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10H3Z" />
                  </svg>
                </a>
              )}
              {session.terminal && (
                <button
                  onClick={() => {
                    if (window.confirm('停止此 Claude 进程？会话记录仍由官方 CLI 保存。'))
                      void act('stop')
                  }}
                  aria-label="停止会话"
                >
                  ⏹
                </button>
              )}
            </header>
            {terminal && (
              <StartupTerminal
                sessionId={session.id}
                connected={session.connected}
                command={command}
                listen={listen}
              />
            )}
            <div className="claude-messages" ref={history.scroller} aria-label="会话消息">
              <div data-claude-spacer="top" />
              {history.hasOlder && (
                <button className="claude-load" disabled={history.loading} onClick={history.older}>
                  {history.loading ? '加载中…' : '更早的消息'}
                </button>
              )}
              <Messages
                items={
                  stream && !history.browsing ? history.items.slice(streamStart) : history.items
                }
                command={command}
                sessionId={sessionId}
              />
              {stream && !history.browsing && (
                <article className="claude-message claude-stream">
                  <div className="claude-message-label">
                    <small>Claude 正在输出</small>
                    <CopyMessage text={stream} />
                  </div>
                  <Markdown
                    remarkPlugins={[remarkGfm, remarkContentLinks]}
                    urlTransform={(url) => url}
                    components={{
                      a: ({ href, children }) => <ContentLink href={href}>{children}</ContentLink>,
                      pre: ({ children }) => <LinkedPre>{children}</LinkedPre>
                    }}
                  >
                    {stream}
                  </Markdown>
                </article>
              )}
              {!history.items.length && !stream && (
                <p className="claude-empty">
                  {session.nativeId ? '等待消息。' : '请先完成原生启动确认。'}
                  {session.error && ` ${session.error}`}
                </p>
              )}
              {history.error && <p role="alert">{history.error}</p>}
              <div data-claude-spacer="bottom" />
            </div>
            <div ref={composer.ref} className="claude-footer">
              {(history.browsing || !history.atBottom) && (
                <button
                  className="claude-bottom"
                  aria-label="回到底部"
                  onClick={() => void history.latest()}
                >
                  ↓
                </button>
              )}
              {!!permissions.length && (
                <section className="claude-permissions" aria-label="工具审批">
                  {permissions.map((permission) => (
                    <article key={permission.id}>
                      <strong>{permission.tool}</strong>
                      <p>{permission.description}</p>
                      <details>
                        <summary>请求详情</summary>
                        <pre>{permission.preview}</pre>
                      </details>
                      <div>
                        {[
                          ['deny', '拒绝'],
                          ['allow', '允许本次']
                        ].map(([behavior, label]) => (
                          <button
                            key={behavior}
                            disabled={
                              !connected ||
                              !session.connected ||
                              permission.state !== 'pending' ||
                              pendingVerdict === permission.id
                            }
                            onClick={() => {
                              setPendingVerdict(permission.id)
                              void act('verdict', { requestId: permission.id, behavior }).finally(
                                () => setPendingVerdict('')
                              )
                            }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </article>
                  ))}
                </section>
              )}
              <div className={`claude-composer ${composer.editing ? 'editing' : ''}`}>
                <form onSubmit={(event) => void send(event)}>
                  <textarea
                    aria-label="消息"
                    placeholder="发送给 Claude…"
                    rows={1}
                    value={draft}
                    maxLength={12000}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                  <button
                    aria-label="发送消息"
                    disabled={
                      sending ||
                      !connected ||
                      !session.connected ||
                      !session.nativeId ||
                      !draft.trim()
                    }
                  >
                    {sending ? '…' : '↑'}
                  </button>
                  {session.state === 'working' && session.owned && (
                    <button
                      type="button"
                      onClick={() => void act('interrupt')}
                      aria-label="中断任务"
                    >
                      ■
                    </button>
                  )}
                </form>
              </div>
            </div>
          </>
        ) : (
          <p className="claude-desktop-empty">选择会话，或新建一个 Claude 会话。</p>
        )}

        {error && (
          <div className="claude-error" role="alert">
            <span>{error}</span>
            <button aria-label="关闭提示" onClick={() => setError('')}>
              ×
            </button>
          </div>
        )}
      </section>
    </ContentScope.Provider>
  )
}
