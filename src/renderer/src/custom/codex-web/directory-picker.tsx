import { useCallback, useEffect, useRef, useState } from 'react'
import type { CodexDirectoryListing, CodexRecord } from '../../../../shared/codex-web'

export function DirectoryPicker({
  command,
  initialPath,
  recent,
  onSelect,
  onCancel
}: {
  command: (action: string, params?: CodexRecord) => Promise<CodexRecord>
  initialPath: string
  recent: string[]
  onSelect: (path: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [listing, setListing] = useState<CodexDirectoryListing>()
  const [input, setInput] = useState(initialPath)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const sequence = useRef(0)
  const browse = useCallback(
    async (path?: string): Promise<void> => {
      const request = ++sequence.current
      setLoading(true)
      setError('')
      try {
        const result = await command('directories', path ? { path } : {})
        if (request !== sequence.current) return
        setListing(result as CodexDirectoryListing)
        setInput(result.path)
      } catch (error) {
        if (request === sequence.current)
          setError(error instanceof Error ? error.message : String(error))
      } finally {
        if (request === sequence.current) setLoading(false)
      }
    },
    [command]
  )
  useEffect(() => {
    void browse(initialPath)
    return () => {
      sequence.current++
    }
  }, [browse, initialPath])

  return (
    <section aria-label="选择工作目录">
      <div className="create-heading directory-heading">
        <div>
          <span className="eyebrow">NEW SESSION</span>
          <h2>选择工作目录</h2>
        </div>
        <button type="button" className="icon-button" aria-label="关闭新建会话" onClick={onCancel}>
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
      <p className="directory-intro">选择运行 Sparkle 的电脑上的文件夹。</p>
      <div className="directory-shortcuts" aria-label="常用位置">
        {listing && (
          <>
            <button type="button" disabled={loading} onClick={() => void browse(listing.home)}>
              主目录
            </button>
            {listing.roots.map((root) => (
              <button type="button" key={root} disabled={loading} onClick={() => void browse(root)}>
                {root}
              </button>
            ))}
          </>
        )}
        {recent.slice(0, 4).map((path) => (
          <button
            type="button"
            key={path}
            disabled={loading}
            title={path}
            onClick={() => void browse(path)}
          >
            {path
              .replace(/[\\/]+$/, '')
              .split(/[\\/]/)
              .pop() || path}
          </button>
        ))}
      </div>
      <div className="directory-address">
        <button
          type="button"
          className="directory-up"
          aria-label="上一级"
          disabled={loading || !listing?.parent}
          onClick={() => void browse(listing?.parent || undefined)}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m5 11 7-7 7 7M12 4v16" />
          </svg>
        </button>
        <input
          aria-label="目录路径"
          placeholder="输入绝对路径"
          value={input}
          disabled={loading}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void browse(input.trim())
            }
          }}
        />
        <button
          type="button"
          className="directory-go"
          disabled={loading || !input.trim()}
          onClick={() => void browse(input.trim())}
        >
          前往
        </button>
      </div>
      <div className="directory-current">
        <span>当前目录</span>
        <strong>{listing?.path || '尚未选择'}</strong>
      </div>
      <div className="directory-list" aria-label="文件夹列表" aria-busy={loading}>
        {loading ? (
          <p>正在读取文件夹…</p>
        ) : listing?.entries.length ? (
          listing.entries.map((entry) => (
            <button
              type="button"
              key={entry.path}
              aria-label={`打开 ${entry.name}`}
              onClick={() => void browse(entry.path)}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10H3Z" />
              </svg>
              <span>{entry.name}</span>
              <span aria-hidden="true">›</span>
            </button>
          ))
        ) : (
          <p>{listing ? '此目录没有子文件夹' : '请输入路径后重试'}</p>
        )}
      </div>
      {listing?.truncated && (
        <p className="create-note">只显示前 5000 个文件夹，可输入路径跳转。</p>
      )}
      {error && (
        <p className="create-error" role="alert">
          {error}
        </p>
      )}
      <div className="create-actions">
        <button type="button" className="button secondary" onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          className="button primary"
          disabled={loading || !listing || !!error}
          onClick={() => listing && onSelect(listing.path)}
        >
          选择此目录
        </button>
      </div>
    </section>
  )
}
