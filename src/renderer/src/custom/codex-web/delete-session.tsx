import { useEffect, useRef, useState } from 'react'
import type { CodexRecord } from '../../../../shared/codex-web'

export interface DeleteSessionTarget {
  instanceId: string
  threadId: string
  name: string
  cwd?: string
}

export function DeleteSessionDialog({
  target,
  command,
  online,
  onDeleted,
  onClose
}: {
  target: DeleteSessionTarget
  command: (action: string, params?: CodexRecord) => Promise<CodexRecord>
  online: boolean
  onDeleted: () => void
  onClose: () => void
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    dialog.current?.showModal()
    cancel.current?.focus()
  }, [])
  const remove = async (): Promise<void> => {
    if (saving || !online) return
    setSaving(true)
    setError('')
    try {
      await command('delete', {
        instanceId: target.instanceId,
        threadId: target.threadId,
        confirmed: true
      })
      onDeleted()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      className="create-dialog delete-session-dialog"
      aria-label="删除会话"
      onClose={onClose}
      onCancel={(event) => {
        if (saving) event.preventDefault()
      }}
      onClick={(event) => {
        if (!saving && event.target === event.currentTarget) dialog.current?.close()
      }}
    >
      <div className="create-heading">
        <h2>永久删除会话？</h2>
      </div>
      <p className="delete-session-name">{target.name}</p>
      <p className="create-note">{target.threadId}</p>
      {target.cwd && <p className="create-note">{target.cwd}</p>}
      <p className="create-note">
        将永久删除此会话及其子代理会话的历史，正在运行的相关任务会停止。此操作无法撤销。
      </p>
      {error && (
        <p className="create-error" role="alert">
          {error}
        </p>
      )}
      {!online && (
        <p className="create-error" role="alert">
          连接已断开，请重连后再删除。
        </p>
      )}
      <div className="create-actions">
        <button
          ref={cancel}
          type="button"
          className="button secondary"
          disabled={saving}
          onClick={() => dialog.current?.close()}
        >
          取消
        </button>
        <button
          type="button"
          className="button delete-session-confirm"
          disabled={saving || !online}
          onClick={() => void remove()}
        >
          {saving ? '正在删除…' : '永久删除'}
        </button>
      </div>
    </dialog>
  )
}
