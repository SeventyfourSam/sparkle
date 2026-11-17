import { useState } from 'react'
import type { ClaudeChannelSession } from '../../../../shared/claude-channel'
import { claudeStateLabels } from './channel'
import './style.css'

export type SessionProvider = 'codex' | 'claude'
export function SessionProviderChoice({
  value,
  disabled,
  onChange
}: {
  value: SessionProvider
  disabled: boolean
  onChange: (value: SessionProvider) => void
}): React.JSX.Element {
  return (
    <div className="session-provider-choice" aria-label="会话类型">
      {(['codex', 'claude'] as const).map((provider) => (
        <button
          type="button"
          disabled={disabled}
          key={provider}
          aria-pressed={value === provider}
          onClick={() => onChange(provider)}
        >
          {provider === 'codex' ? 'Codex' : 'Claude'}
        </button>
      ))}
    </div>
  )
}

export function ClaudeSessionCard({
  session,
  selected,
  onSelect
}: {
  session: ClaudeChannelSession
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  const folder =
    session.cwd
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || session.cwd
  return (
    <button
      className={`thread-card ${selected ? 'selected' : ''}`}
      data-provider="claude"
      onClick={onSelect}
    >
      <div className="thread-card-top">
        <span className="project">{folder}</span>
        <time>
          {new Date(session.createdAt).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit'
          })}
        </time>
      </div>
      <h2>{session.title}</h2>
      <p>{session.cwd}</p>
      <div className="thread-card-bottom">
        <span className={`badge ${session.connected ? 'active' : 'offline'}`}>
          <i />
          {claudeStateLabels[session.state]}
        </span>
        <span>Claude{session.model ? ` · ${session.model}` : ''}</span>
      </div>
    </button>
  )
}

export function ClaudeConnectionHelp(): React.JSX.Element {
  return (
    <details className="claude-connection-help">
      <summary>接入说明</summary>
      <p>
        电脑终端直接使用 claude，启动时会自动附加 Sparkle 接入参数。已有会话可使用 claude --resume
        会话ID 恢复；未启用 Channel 的运行中会话，需先退出再恢复。
      </p>
      <p>
        请先在官方 Claude Code 中登录。原生界面仍可能要求确认项目信任和 Channel；Sparkle
        网页无需访问码。
      </p>
    </details>
  )
}

export function ClaudeNewSession({
  cwd,
  busy,
  connected,
  error,
  onSubmit,
  onDirectory,
  onCancel
}: {
  cwd: string
  busy: boolean
  connected: boolean
  error: string
  onSubmit: (resume: string) => void
  onDirectory: () => void
  onCancel: () => void
}): React.JSX.Element {
  const [resume, setResume] = useState('')
  return (
    <form
      className="claude-new-session"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit(resume.trim())
      }}
    >
      <div className="create-heading">
        <h2>新建 Claude 会话</h2>
        <button
          type="button"
          className="icon-button"
          disabled={busy}
          aria-label="关闭新建会话"
          onClick={onCancel}
        >
          ×
        </button>
      </div>
      <div className="create-field">
        工作目录
        <button type="button" className="selected-directory" disabled={busy} onClick={onDirectory}>
          <span>{cwd}</span>
          <strong>更换</strong>
        </button>
      </div>
      <label className="create-field">
        恢复已有会话（可选）
        <input
          aria-label="Claude 会话 ID"
          value={resume}
          onChange={(event) => setResume(event.target.value)}
          placeholder="完整的会话 ID，留空则新建"
          disabled={busy}
        />
      </label>
      <p className="create-note">
        请先在电脑的官方 Claude Code 中登录。启动后需要阅读并确认原生提示。
      </p>
      {error && (
        <p className="create-error" role="alert">
          {error}
        </p>
      )}
      <div className="create-actions">
        <button type="button" className="button secondary" disabled={busy} onClick={onCancel}>
          取消
        </button>
        <button className="button primary" disabled={busy || !connected}>
          {busy ? '启动中…' : resume.trim() ? '恢复会话' : '创建会话'}
        </button>
      </div>
    </form>
  )
}
