import {
  isValidElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import { ContentLink, ContentScope } from './content-links'
import { contentHref, type LinkScope } from '../../../../shared/codex-web-links'
import { fileFormat, normalizeSource } from '../../../../shared/codex-web-file-formats'
import { SourceCode } from './source-code'

interface HtmlNode {
  type: string
  tagName?: string
  value?: string
  children?: HtmlNode[]
  properties?: Record<string, unknown>
  position?: { start: { line: number }; end: { line: number } }
}
function documentStructure(): (tree: HtmlNode) => void {
  return (tree) => {
    const seen = new Map<string, number>()
    const text = (node: HtmlNode): string => node.value || (node.children || []).map(text).join('')
    const walk = (node: HtmlNode): void => {
      if (node.type === 'element') {
        node.properties ||= {}
        if (/^h[1-6]$/.test(node.tagName || '')) {
          const slug = text(node)
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s_-]/gu, '')
            .trim()
            .replace(/\s+/g, '-')
          const count = seen.get(slug) || 0
          seen.set(slug, count + 1)
          node.properties.id = `file-heading-${count ? `${slug}-${count}` : slug}`
        }
        if (/^(?:p|h[1-6]|pre|li|blockquote|table|hr)$/.test(node.tagName || '') && node.position) {
          node.properties['data-source-line'] = node.position.start.line
          node.properties['data-source-end'] = node.position.end.line
        }
      }
      node.children?.forEach(walk)
    }
    walk(tree)
  }
}
function documentHref(href: string, scope?: LinkScope): string | undefined {
  if (href.startsWith('/codex/file?')) return href
  if (href.startsWith('#')) {
    const query = new URLSearchParams(location.search)
    query.delete('line')
    query.delete('column')
    return `${location.pathname}?${query}${href}`
  }
  if (!/^https?:\/\//i.test(href) && href.includes('#') && !/#L\d+/i.test(href)) {
    const index = href.indexOf('#'),
      base = contentHref(href.slice(0, index), scope)
    return base ? base + href.slice(index) : undefined
  }
  return contentHref(href, scope)
}
function documentUrls(scope: LinkScope): (tree: HtmlNode) => void {
  return (tree) => {
    const walk = (node: HtmlNode): void => {
      const key = node.tagName === 'a' ? 'href' : node.tagName === 'img' ? 'src' : undefined
      if (key && typeof node.properties?.[key] === 'string')
        node.properties[key] = documentHref(node.properties[key] as string, scope)
      node.children?.forEach(walk)
    }
    walk(tree)
  }
}
function DocumentLink({
  href,
  children
}: {
  href?: string
  children: ReactNode
}): React.JSX.Element {
  const scope = useContext(ContentScope)
  const url = href ? documentHref(href, scope) : undefined
  if (url)
    return (
      <a href={url} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    )
  return <ContentLink href={href}>{children}</ContentLink>
}
function DocumentImage({ src, alt }: { src?: string; alt?: string }): React.JSX.Element {
  const scope = useContext(ContentScope)
  const [failed, setFailed] = useState(false)
  const href = src ? documentHref(src, scope) : undefined
  const url = href?.startsWith('/codex/file?')
    ? `/api/file?${href.slice(href.indexOf('?') + 1)}&mode=raw`
    : href
  return !url || failed ? (
    <DocumentLink href={src}>{alt || '图片'}</DocumentLink>
  ) : (
    <DocumentLink href={src}>
      <img src={url} alt={alt || ''} loading="lazy" onError={() => setFailed(true)} />
    </DocumentLink>
  )
}
function CodeBlock({
  children,
  node,
  line,
  column
}: {
  children: ReactNode
  node?: HtmlNode
  line: number
  column: number
}): React.JSX.Element {
  if (isValidElement<{ children: ReactNode; className?: string }>(children))
    return (
      <div data-source-line={node?.position?.start.line} data-source-end={node?.position?.end.line}>
        <SourceCode
          text={String(children.props.children || '')}
          language={children.props.className?.replace(/^language-/, '')}
          line={
            node?.position && line > node.position.start.line && line < node.position.end.line
              ? line - node.position.start.line
              : 0
          }
          column={column}
        />
      </div>
    )
  return <pre>{children}</pre>
}
export default function FormattedFile({
  name,
  path,
  text,
  line,
  column,
  instanceId,
  threadId
}: {
  name: string
  path: string
  text: string
  line: number
  column: number
  instanceId: string
  threadId: string
}): React.JSX.Element {
  const format = fileFormat(name)
  const [source, setSource] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const scope = useMemo(
    () => ({ instanceId, threadId, cwd: path.replace(/[\\/][^\\/]+$/, '') }),
    [instanceId, threadId, path]
  )
  useEffect(() => {
    if (format.kind !== 'markdown' || source) return
    let disposed = false
    const locate = (): void => {
      const node = root.current
      if (!node || disposed) return
      let selected: HTMLElement | undefined
      if (line > 0) {
        selected = [...node.querySelectorAll<HTMLElement>('[data-source-line]')]
          .filter(
            (entry) =>
              Number(entry.dataset.sourceLine) <= line && Number(entry.dataset.sourceEnd) >= line
          )
          .sort(
            (a, b) =>
              Number(a.dataset.sourceEnd) -
              Number(a.dataset.sourceLine) -
              (Number(b.dataset.sourceEnd) - Number(b.dataset.sourceLine))
          )[0]
        if (selected) selected.dataset.sourceSelected = 'true'
      } else if (location.hash) {
        try {
          selected =
            document.getElementById(decodeURIComponent(location.hash.slice(1))) || undefined
        } catch {
          /* Invalid hash leaves the page at the start. */
        }
      }
      selected?.scrollIntoView({ block: 'center' })
    }
    requestAnimationFrame(locate)
    window.addEventListener('hashchange', locate)
    return () => {
      disposed = true
      window.removeEventListener('hashchange', locate)
    }
  }, [format.kind, line, source, text])
  return (
    <ContentScope.Provider value={scope}>
      {format.kind === 'markdown' && (
        <div className="file-format-controls">
          <button type="button" onClick={() => setSource((value) => !value)}>
            {source ? '预览' : '源码'}
          </button>
        </div>
      )}
      {format.kind === 'markdown' && !source ? (
        <div className="markdown file-markdown" ref={root}>
          <Markdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeRaw, [documentUrls, scope], rehypeSanitize, documentStructure]}
            urlTransform={(url) => url}
            components={{
              a: ({ href, children }) => <DocumentLink href={href}>{children}</DocumentLink>,
              img: ({ src, alt }) => (
                <DocumentImage src={typeof src === 'string' ? src : undefined} alt={alt} />
              ),
              pre: ({ children, node }) => (
                <CodeBlock node={node} line={line} column={column}>
                  {children}
                </CodeBlock>
              )
            }}
          >
            {normalizeSource(text)}
          </Markdown>
        </div>
      ) : (
        <SourceCode text={text} language={format.language} line={line} column={column} />
      )}
    </ContentScope.Provider>
  )
}
