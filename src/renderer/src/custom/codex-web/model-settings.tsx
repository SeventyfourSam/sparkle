import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { CodexRecord } from '../../../../shared/codex-web'
import type { CodexWebModel } from '../../../../shared/codex-web-models'

export function ModelSettings({
  command,
  instanceId,
  thread,
  online,
  onClose,
  onSaved
}: {
  command: (action: string, params?: CodexRecord) => Promise<CodexRecord>
  instanceId: string
  thread: CodexRecord
  online: boolean
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const initial = useRef({ model: thread.model || '', effort: thread.reasoningEffort ?? null })
  const [models, setModels] = useState<CodexWebModel[]>([])
  const [model, setModel] = useState(initial.current.model)
  const [effort, setEffort] = useState(initial.current.effort || '')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const threadId = String(thread.id)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  useEffect(() => {
    let disposed = false
    setLoading(true)
    setError('')
    void command('models', { instanceId, threadId })
      .then((result) => {
        if (disposed) return
        const values = result.models as CodexWebModel[]
        setModels(values)
        if (!values.length) throw new Error('当前 Codex 没有提供可选模型')
        const selected =
          values.find((entry) => entry.model === initial.current.model) ||
          (!initial.current.model ? values[0] : undefined)
        if (selected) {
          setModel(selected.model)
          const options = selected.supportedReasoningEfforts
          setEffort(
            options.some((entry) => entry.reasoningEffort === initial.current.effort)
              ? initial.current.effort!
              : options.find((entry) => entry.reasoningEffort === selected.defaultReasoningEffort)
                  ?.reasoningEffort ||
                  options[0]?.reasoningEffort ||
                  ''
          )
        }
      })
      .catch((error) => {
        if (!disposed) setError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [command, instanceId, threadId, retry])
  const selected = models.find((entry) => entry.model === model)
  const externallyChanged =
    !saving &&
    ((thread.model || '') !== initial.current.model ||
      (thread.reasoningEffort ?? null) !== initial.current.effort)
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!selected || loading || saving || !online || externallyChanged) return
    setSaving(true)
    setError('')
    try {
      await command('settings', {
        instanceId,
        threadId,
        model,
        ...(effort ? { effort } : {}),
        expectedModel: initial.current.model,
        expectedEffort: initial.current.effort
      })
      onSaved()
      onClose()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      className="create-dialog model-settings-dialog"
      aria-label="模型与推理强度"
      onClose={onClose}
      onCancel={(event) => {
        if (saving) event.preventDefault()
      }}
      onClick={(event) => {
        if (!saving && event.target === event.currentTarget) onClose()
      }}
    >
      <form onSubmit={(event) => void submit(event)}>
        <div className="create-heading">
          <div>
            <span className="eyebrow">SESSION SETTINGS</span>
            <h2>模型与推理强度</h2>
          </div>
          <button
            type="button"
            className="icon-button model-settings-close"
            disabled={saving}
            aria-label="关闭模型设置"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <label className="create-field">
          模型（model）
          <select
            aria-label="模型"
            autoFocus
            disabled={loading || saving || !online}
            value={model}
            onChange={(event) => {
              const next = models.find((entry) => entry.model === event.target.value)
              setModel(event.target.value)
              setError('')
              const options = next?.supportedReasoningEfforts || []
              if (!options.some((entry) => entry.reasoningEffort === effort))
                setEffort(
                  options.find((entry) => entry.reasoningEffort === next?.defaultReasoningEffort)
                    ?.reasoningEffort ||
                    options[0]?.reasoningEffort ||
                    ''
                )
            }}
          >
            {!selected && (
              <option value={model}>{model || (loading ? '正在加载…' : '请选择模型')}</option>
            )}
            {models.map((entry) => (
              <option key={entry.model} value={entry.model}>
                {entry.displayName}
              </option>
            ))}
          </select>
        </label>
        {selected?.description && <p className="model-description">{selected.description}</p>}
        {!loading && !selected && !!models.length && (
          <p className="create-note">当前模型未出现在可选列表中，请选择一个模型。</p>
        )}
        <label className="create-field">
          推理强度（reasoning）
          <select
            aria-label="推理强度"
            disabled={loading || saving || !online || !selected?.supportedReasoningEfforts.length}
            value={effort}
            onChange={(event) => setEffort(event.target.value)}
          >
            {!selected?.supportedReasoningEfforts.length && (
              <option value="">此模型未提供推理强度选项</option>
            )}
            {selected?.supportedReasoningEfforts.map((entry) => (
              <option key={entry.reasoningEffort} value={entry.reasoningEffort}>
                {entry.reasoningEffort}
                {entry.reasoningEffort === selected.defaultReasoningEffort ? '（模型默认）' : ''}
              </option>
            ))}
          </select>
        </label>
        <p className="model-description">
          {
            selected?.supportedReasoningEfforts.find((entry) => entry.reasoningEffort === effort)
              ?.description
          }
        </p>
        <p className="create-note">修改用于后续任务；当前运行中的任务继续使用原设置。</p>
        {loading && (
          <p className="create-note" role="status">
            正在获取此 Codex 实例的可选模型…
          </p>
        )}
        {externallyChanged && (
          <p className="create-error" role="alert">
            设置已在其他客户端更改，请关闭后重新打开。
          </p>
        )}
        {error && (
          <p className="create-error" role="alert">
            {error}
          </p>
        )}
        <div className="create-actions">
          {!models.length && !loading && (
            <button
              type="button"
              className="button secondary"
              onClick={() => setRetry((value) => value + 1)}
            >
              重试
            </button>
          )}
          <button type="button" className="button secondary" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={loading || saving || !online || !selected || externallyChanged}
          >
            {saving ? '正在保存…' : '保存'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
