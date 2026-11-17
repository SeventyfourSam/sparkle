import { lazy, Suspense, useEffect, useState } from 'react'
import type { CodexRecord } from '../../../../shared/codex-web'
import { contentHref } from '../../../../shared/codex-web-links'
import { usePageGestures } from './page-gestures'

const FormattedFile = lazy(() => import('./file-formatted'))

export function FileView(): React.JSX.Element {
  usePageGestures()
  const [file, setFile] = useState<CodexRecord>()
  const [error, setError] = useState('')
  const query = new URLSearchParams(location.search)
  const line = Math.max(0, Math.floor(Number(query.get('line')) || 0))
  const column = Math.max(0, Math.floor(Number(query.get('column')) || 0))
  useEffect(() => {
    const abort = new AbortController()
    const params = new URLSearchParams(location.search)
    params.delete('mode')
    void fetch(`/api/file?${params}`, { signal: abort.signal })
      .then(async (response) => {
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || '无法打开文件')
        setFile(result)
        document.title = `${result.name} · Sparkle`
      })
      .catch((error) => {
        if (error.name !== 'AbortError') setError(error.message)
      })
    return () => abort.abort()
  }, [])
  const scope = {
    instanceId: query.get('instanceId') || '',
    threadId: query.get('threadId') || '',
    sessionId: query.get('provider') === 'claude' ? query.get('sessionId') || undefined : undefined,
    nativeId: query.get('nativeId') || undefined
  }
  return (
    <main className="file-view">
      <header className="file-view-header">
        <strong>{file?.name || '文件预览'}</strong>
        {file?.kind !== 'directory' && file?.downloadUrl && (
          <a href={file.downloadUrl} target="_blank" rel="noopener noreferrer">
            下载
          </a>
        )}
      </header>
      <div className="file-view-path">
        {file?.path || query.get('path')}
        {line > 0 ? ` · 第 ${line} 行${column ? `，第 ${column} 列` : ''}` : ''}
      </div>
      {error ? (
        <div className="inline-error" role="alert">
          {error}
        </div>
      ) : !file ? (
        <div className="loading">正在打开…</div>
      ) : (
        <div className="file-view-content">
          {file.truncated && (
            <div className="lazy-notice">
              当前显示部分内容。
              {file.kind === 'directory' ? '目录最多显示 1000 项。' : '可下载完整文件。'}
            </div>
          )}
          {file.kind === 'text' && (
            <Suspense fallback={<div className="loading">正在渲染…</div>}>
              <FormattedFile
                name={file.name}
                path={file.path}
                text={file.text || ''}
                line={line}
                column={column}
                instanceId={scope.instanceId}
                threadId={scope.threadId}
                sessionId={scope.sessionId}
                nativeId={scope.nativeId}
              />
            </Suspense>
          )}
          {file.kind === 'image' && <img src={file.rawUrl} alt={file.name} />}
          {file.kind === 'pdf' && <iframe src={file.rawUrl} title={file.name} />}
          {file.kind === 'directory' && (
            <ul>
              {file.parent && (
                <li>
                  <a
                    href={contentHref(file.parent, scope)}
                    target="_self"
                    aria-label="返回上级目录"
                  >
                    ..
                  </a>
                </li>
              )}
              {file.entries.map((entry: CodexRecord) => (
                <li key={entry.path}>
                  <a
                    href={contentHref(entry.path, scope)}
                    target={entry.directory ? '_self' : '_blank'}
                    rel="noopener noreferrer"
                  >
                    {entry.directory ? '▸ ' : ''}
                    {entry.name}
                    {entry.directory ? '/' : ''}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {file.kind === 'download' && <p>此文件可通过右上角下载，在手机上的对应应用中打开。</p>}
        </div>
      )}
    </main>
  )
}
