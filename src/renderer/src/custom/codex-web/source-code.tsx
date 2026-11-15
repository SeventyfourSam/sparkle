import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  codeLanguage,
  escapedSource,
  normalizeSource,
  sourceSelection
} from '../../../../shared/codex-web-file-formats'
import { highlightAsync } from './syntax-client'

// Keep lexer spans intact across multiline comments and strings. Coordinates are
// applied to escaped text nodes rather than splicing markup into the source.
function selectedHtml(html: string, text: string, line: number, column: number): string {
  const selection = sourceSelection(text, line, column)
  if (!selection) return html
  const root = document.createElement('code')
  root.innerHTML = html
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  let offset = 0,
    anchored = false
  for (const node of nodes) {
    const value = node.data,
      start = offset
    offset += value.length
    if (offset < selection.start || start > selection.end) continue
    const points = [0, value.length, selection.start - start, selection.end - start]
    if (selection.columnStart !== undefined)
      points.push(selection.columnStart - start, selection.columnStart + 1 - start)
    const cuts = [...new Set(points.filter((point) => point >= 0 && point <= value.length))].sort(
      (a, b) => a - b
    )
    const fragment = document.createDocumentFragment()
    for (let index = 0; index < cuts.length - 1; index++) {
      const a = cuts[index],
        b = cuts[index + 1],
        position = start + a
      const piece = document.createTextNode(value.slice(a, b))
      if (position >= selection.start && position < selection.end) {
        const mark = document.createElement('mark')
        mark.className = 'source-selected-line'
        mark.append(piece)
        if (position === selection.columnStart) {
          const cursor = document.createElement('span')
          cursor.className = 'file-column'
          cursor.append(piece)
          mark.append(cursor)
          cursor.dataset.sourceSelection = 'true'
          anchored = true
        } else if (!anchored && selection.columnStart === undefined) {
          mark.dataset.sourceSelection = 'true'
          anchored = true
        }
        fragment.append(mark)
      } else fragment.append(piece)
    }
    node.replaceWith(fragment)
  }
  if (!anchored) {
    const mark = document.createElement('mark')
    mark.textContent = ' '
    mark.dataset.sourceSelection = 'true'
    if (selection.columnStart !== undefined) mark.className = 'file-column'
    const target = selection.columnStart ?? selection.start
    const cursor = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let at = 0,
      inserted = false
    while (cursor.nextNode()) {
      const node = cursor.currentNode as Text
      if (at + node.length >= target) {
        const range = document.createRange()
        range.setStart(node, Math.max(0, target - at))
        range.collapse(true)
        range.insertNode(mark)
        inserted = true
        break
      }
      at += node.length
    }
    if (!inserted) root.append(mark)
  }
  return root.innerHTML
}

export function SourceCode({
  text,
  language,
  line = 0,
  column = 0
}: {
  text: string
  language?: string
  line?: number
  column?: number
}): React.JSX.Element {
  const source = useMemo(() => normalizeSource(text), [text])
  const name = codeLanguage(language || '')
  const [result, setResult] = useState<{ source: string; language: string; html: string }>()
  const [failed, setFailed] = useState(false)
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!name) return
    let disposed = false
    setFailed(false)
    let request: ReturnType<typeof highlightAsync>
    try {
      request = highlightAsync(source, name)
      void request.result
        .then((html) => {
          if (!disposed) setResult({ source, language: name, html })
        })
        .catch(() => {
          if (!disposed) setFailed(true)
        })
    } catch {
      setFailed(true)
    }
    return () => {
      disposed = true
      request?.cancel()
    }
  }, [source, name])
  const html = useMemo(
    () =>
      selectedHtml(
        result?.source === source && result.language === name ? result.html : escapedSource(source),
        source,
        line,
        column
      ),
    [result, source, name, line, column]
  )
  useLayoutEffect(() => {
    ref.current
      ?.querySelector<HTMLElement>('[data-source-selection]')
      ?.scrollIntoView({ block: 'center', inline: 'center' })
  }, [html])
  return (
    <>
      {failed && <div className="lazy-notice">语法高亮暂不可用，已显示源码。</div>}
      <pre className="source-code">
        <code
          ref={ref}
          className={`hljs${name ? ` language-${name}` : ''}`}
          data-language={name || 'text'}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </pre>
    </>
  )
}
