import { useEffect, useRef, useState } from 'react'
import type { CodexInstance, CodexRecord, CodexSessionPage } from '../../../../shared/codex-web'
import './session-picker.css'

type Command = (action: string, params?: CodexRecord) => Promise<CodexRecord>
type Target = { instanceId: string; threadId: string }

export function SessionHistory({
  command,
  instanceId,
  cwd,
  disabled,
  onLoadingChange,
  onResume
}: {
  command: Command
  instanceId: string
  cwd?: string
  disabled: boolean
  onLoadingChange?: (loading: boolean) => void
  onResume: (threadId: string) => Promise<void>
}): React.JSX.Element {
  const [page, setPage] = useState<CodexSessionPage>({ data: [], nextCursor: null })
  const [cursors, setCursors] = useState<(string | null)[]>([null])
  const [index, setIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [resuming, setResuming] = useState('')
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const cursor = cursors[index]
  useEffect(() => {
    let disposed = false
    setLoading(true)
    onLoadingChange?.(true)
    setError('')
    void command('sessions', { instanceId, ...(cwd ? { cwd } : {}), cursor })
      .then((result) => {
        if (disposed) return
        setPage(result as CodexSessionPage)
        if (list.current) list.current.scrollTop = 0
      })
      .catch((error) => {
        if (!disposed) {
          setPage({ data: [], nextCursor: null })
          setError(error instanceof Error ? error.message : String(error))
        }
      })
      .finally(() => {
        if (!disposed) {
          setLoading(false)
          onLoadingChange?.(false)
        }
      })
    return () => {
      disposed = true
    }
  }, [command, instanceId, cwd, cursor, retry, onLoadingChange])
  const resume = async (threadId: string): Promise<void> => {
    if (disabled || resuming || loading) return
    setResuming(threadId)
    setError('')
    try {
      await onResume(threadId)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setResuming('')
    }
  }
  const locked = disabled || loading || !!resuming
  return (
    <section className="session-history" aria-label="已有会话">
      <h3>恢复已有会话</h3>
      <p className="create-note">
        {loading
          ? '正在查询历史会话…'
          : page.data.length
            ? '要继续之前的会话吗？选择一条恢复，或另建新会话。'
            : error
              ? '历史会话暂时不可用，仍可新建会话。'
              : '没有找到已有会话。'}
      </p>
      <div ref={list} className="session-history-list" aria-busy={loading}>
        {!loading &&
          page.data.map((thread) => (
            <button
              type="button"
              key={thread.id}
              disabled={locked}
              title={thread.id}
              onClick={() => void resume(thread.id)}
            >
              <strong>{thread.name || thread.preview || '未命名会话'}</strong>
              <span>{thread.cwd}</span>
              <small>
                {resuming === thread.id
                  ? '正在恢复…'
                  : thread.runningInstanceId
                    ? '正在运行 · 打开原实例'
                    : thread.updatedAt
                      ? new Date(thread.updatedAt * 1000).toLocaleString('zh-CN', {
                          month: 'numeric',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit'
                        })
                      : '恢复会话'}
              </small>
            </button>
          ))}
      </div>
      {error && (
        <p className="create-error" role="alert">
          {error}{' '}
          <button
            type="button"
            disabled={locked}
            onClick={() => {
              setLoading(true)
              setRetry((value) => value + 1)
            }}
          >
            重试
          </button>
        </p>
      )}
      {(index > 0 || page.nextCursor) && (
        <div className="session-history-pages">
          <button
            type="button"
            disabled={locked || !index}
            onClick={() => {
              setLoading(true)
              setIndex(index - 1)
            }}
          >
            上一页
          </button>
          <span>第 {index + 1} 页</span>
          <button
            type="button"
            disabled={locked || !page.nextCursor}
            onClick={() => {
              setLoading(true)
              setCursors([...cursors.slice(0, index + 1), page.nextCursor])
              setIndex(index + 1)
            }}
          >
            下一页
          </button>
        </div>
      )}
    </section>
  )
}

export function ResumeSessionDialog({
  command,
  instances,
  initialInstance,
  cwd,
  connected,
  onSelected,
  onClose
}: {
  command: Command
  instances: CodexInstance[]
  initialInstance?: string
  cwd?: string
  connected: boolean
  onSelected: (target: Target) => void
  onClose: () => void
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const [instanceId, setInstanceId] = useState(initialInstance || '')
  const [projectOnly, setProjectOnly] = useState(!!cwd)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  useEffect(() => {
    if (!instances.some((item) => item.ready && item.id === instanceId))
      setInstanceId(instances.find((item) => item.ready)?.id || '')
  }, [instances, instanceId])
  const close = (): void => {
    if (!saving) dialog.current?.close()
  }
  return (
    <dialog
      ref={dialog}
      className="create-dialog resume-dialog"
      aria-label="恢复会话"
      onClose={onClose}
      onCancel={(event) => {
        if (saving) event.preventDefault()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div className="create-heading">
        <h2>恢复会话</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭恢复会话"
          disabled={saving}
          onClick={close}
        >
          ×
        </button>
      </div>
      <label className="create-field">
        Codex 服务
        <select
          aria-label="恢复到 Codex 服务"
          value={instanceId}
          disabled={saving || !connected}
          onChange={(event) => setInstanceId(event.target.value)}
        >
          {!instanceId && <option value="">等待 Codex 接入</option>}
          {instances
            .filter((item) => item.ready)
            .map((item) => (
              <option key={item.id} value={item.id}>
                {{ embedded: '终端', shared: '共享后台', standalone: '独立服务' }[item.runtime]} ·
                PID {item.pid}
              </option>
            ))}
        </select>
      </label>
      {cwd && (
        <label className="session-project-filter">
          <input
            type="checkbox"
            checked={projectOnly}
            disabled={saving}
            onChange={(event) => setProjectOnly(event.target.checked)}
          />
          仅当前项目
        </label>
      )}
      {instanceId && connected ? (
        <SessionHistory
          key={`${instanceId}:${projectOnly ? cwd : ''}`}
          command={command}
          instanceId={instanceId}
          cwd={projectOnly ? cwd : undefined}
          disabled={saving}
          onResume={async (threadId) => {
            setSaving(true)
            try {
              const result = await command('resume', { instanceId, threadId })
              onSelected({ instanceId: result.instanceId, threadId: result.thread.id })
              dialog.current?.close()
            } finally {
              setSaving(false)
            }
          }}
        />
      ) : (
        <p className="create-note">请先启动已连接 Sparkle 的 Codex。</p>
      )}
    </dialog>
  )
}
