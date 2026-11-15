import { createContext, isValidElement, useContext, useMemo, type ReactNode } from 'react'
import {
  contentHref,
  contentTokens,
  fileLocation,
  type LinkScope
} from '../../../../shared/codex-web-links'
export const ContentScope = createContext<LinkScope | undefined>(undefined)
export function ContentBase({
  cwd,
  children
}: {
  cwd?: string
  children: ReactNode
}): React.JSX.Element {
  const parent = useContext(ContentScope)
  const value = useMemo(
    () => (parent ? { ...parent, cwd: cwd || parent.cwd } : undefined),
    [parent, cwd]
  )
  return <ContentScope.Provider value={value}>{children}</ContentScope.Provider>
}
export function ContentLink({
  href,
  children
}: {
  href?: string
  children: ReactNode
}): React.JSX.Element {
  const scope = useContext(ContentScope)
  const url = href ? contentHref(href, scope) : undefined
  return url ? (
    <a href={url} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <span>{children}</span>
  )
}
export function LinkedText({ text }: { text: string }): React.JSX.Element {
  const pieces: ReactNode[] = []
  let offset = 0
  for (const token of contentTokens(text)) {
    pieces.push(
      text.slice(offset, token.start),
      <ContentLink key={token.start} href={token.value}>
        {token.value}
      </ContentLink>
    )
    offset = token.end
  }
  pieces.push(text.slice(offset))
  return <>{pieces}</>
}
export function LinkedPre({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <pre>
      {isValidElement<{ children: ReactNode; className?: string }>(children) ? (
        <code className={children.props.className}>
          <LinkedText text={String(children.props.children || '')} />
        </code>
      ) : (
        children
      )}
    </pre>
  )
}
interface MdNode {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
  position?: { start: { offset?: number }; end: { offset?: number } }
}
// Runs only for mounted Markdown bodies. Existing Markdown/GFM links remain intact.
export function remarkContentLinks(): (tree: MdNode) => void {
  return (tree) => {
    const walk = (node: MdNode): void => {
      if (node.type === 'link' && node.children?.length === 1) {
        const label = node.children[0].value || ''
        if (
          node.position &&
          (node.position.end.offset ?? -1) - (node.position.start.offset ?? -1) === label.length &&
          node.url === `http://${label}` &&
          /\.(?:md|txt|json|ya?ml|toml|tsx?|jsx?|py|rs|go|css|html|sh|ps1)(?::\d+(?::\d+)?)?$/i.test(
            label
          )
        )
          node.url = label
      }
      if (['link', 'image', 'code', 'html'].includes(node.type) || !node.children) return
      node.children = node.children.flatMap((child) => {
        if ((child.type === 'text' || child.type === 'inlineCode') && child.value) {
          if (
            child.type === 'inlineCode' &&
            /^(?:[a-z]:[\\/]|\.{0,2}[\\/]|[\p{L}\p{N}@_.-]+[\\/])/iu.test(child.value) &&
            fileLocation(child.value)
          )
            return [{ type: 'link', url: child.value, children: [child] }]
          const tokens = contentTokens(child.value)
          const children: MdNode[] = []
          let offset = 0
          for (const token of tokens) {
            if (token.start > offset)
              children.push({ type: child.type, value: child.value.slice(offset, token.start) })
            children.push({
              type: 'link',
              url: token.value,
              children: [{ type: child.type, value: token.value }]
            })
            offset = token.end
          }
          if (offset < child.value.length)
            children.push({ type: child.type, value: child.value.slice(offset) })
          return children
        }
        walk(child)
        return [child]
      })
    }
    walk(tree)
  }
}
