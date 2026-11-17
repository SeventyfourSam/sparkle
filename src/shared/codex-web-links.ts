export interface FileLocation {
  path: string
  line?: number
  column?: number
}
export interface LinkScope {
  instanceId?: string
  threadId?: string
  sessionId?: string
  nativeId?: string
  cwd?: string
}

export function fileLocation(value: string): FileLocation | undefined {
  let path = value.trim().replace(/^<|>$/g, '')
  if (!path || path.length > 4096 || [...path].some((char) => char.charCodeAt(0) < 32)) return
  if (/^file:\/\//i.test(path)) {
    try {
      const url = new URL(path)
      if (url.hostname && url.hostname !== 'localhost') return
      path = decodeURIComponent(url.pathname).replace(/^\/([a-z]:\/)/i, '$1') + url.hash
    } catch {
      return
    }
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return
  const suffix = path.match(/(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+)|-L\d+)?)$/i)
  const line = suffix ? Number(suffix[1] || suffix[3]) : undefined
  const column = suffix ? Number(suffix[2] || suffix[4]) || undefined : undefined
  if (suffix) path = path.slice(0, -suffix[0].length)
  if (!/[\\/]/.test(path) && !/^[\p{L}\p{N}_@. -]+\.[a-z][a-z\d_-]*$/iu.test(path)) return
  if (!path || path.startsWith('//') || path.startsWith('\\\\') || /[?#<>|"*]/.test(path)) return
  return { path, line: line && line > 0 ? line : undefined, column }
}

export function contentHref(value: string, scope?: LinkScope): string | undefined {
  if (/^(?:https?:\/\/|www\.)/i.test(value)) {
    try {
      return new URL(/^www\./i.test(value) ? `https://${value}` : value).href
    } catch {
      return
    }
  }
  let decoded = value
  try {
    decoded = decodeURIComponent(value)
  } catch {
    /* A literal percent is valid in a filename. */
  }
  const location = fileLocation(decoded)
  if (!location || !scope) return
  if (!scope.sessionId && (!scope.instanceId || !scope.threadId)) return
  const query = scope.sessionId
    ? new URLSearchParams({ provider: 'claude', sessionId: scope.sessionId, path: location.path })
    : new URLSearchParams({
        instanceId: scope.instanceId!,
        threadId: scope.threadId!,
        path: location.path
      })
  if (scope.nativeId) query.set('nativeId', scope.nativeId)
  if (scope.cwd) query.set('base', scope.cwd)
  if (location.line) query.set('line', String(location.line))
  if (location.column) query.set('column', String(location.column))
  return `/codex/file?${query}`
}

export interface ContentToken {
  start: number
  end: number
  value: string
}
export function contentTokens(text: string): ContentToken[] {
  const pattern =
    /(["'])(?:(?:https?:\/\/|[a-z]:[\\/]|\.{0,2}[\\/]|[\p{L}\p{N}_@.-]+[\\/])[^"'\r\n]+|[\p{L}\p{N}_@. -]+\.[a-z][a-z\d_-]*(?::\d+(?::\d+)?)?)\1|https?:\/\/[^\s<>"'`，。；！？、（）]+|www\.[^\s<>"'`，。；！？、（）]+|[a-z]:[\\/][^\s<>"'`|?*]+|(?:\.{0,2}[\\/])?(?:[\p{L}\p{N}_@.-]+[\\/])+[\p{L}\p{N}_@.\-/:#]*|[\p{L}\p{N}_@.-]+\.[a-z][a-z\d_-]*(?::\d+(?::\d+)?|#L\d+(?:C\d+|-L\d+)?)?/giu
  const result: ContentToken[] = []
  for (const match of text.matchAll(pattern)) {
    const quoted = !!match[1]
    const start = match.index! + (quoted ? 1 : 0)
    let value = (quoted ? match[0].slice(1, -1) : match[0]).replace(/[.,;!?，。；！？、：]+$/u, '')
    for (const [open, close] of [
      ['(', ')'],
      ['[', ']'],
      ['（', '）']
    ])
      while (value.endsWith(close) && value.split(close).length > value.split(open).length)
        value = value.slice(0, -1)
    if (contentHref(value) || fileLocation(value))
      result.push({ start, end: start + value.length, value })
  }
  return result
}
