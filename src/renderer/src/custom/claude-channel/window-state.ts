import type { ClaudeHistoryPage, ClaudeMessage } from '../../../../shared/claude-channel'
import { claudeMessageWindow, isClaudeMessage } from '../../../../shared/claude-channel'

function combineSources(first?: string, second?: string): string | undefined {
  if (!first || !second) return
  try {
    const read = (token: string) => JSON.parse(atob(token.replace(/-/g, '+').replace(/_/g, '/')))
    const a = read(first),
      b = read(second)
    if (a.ino !== b.ino) return
    return btoa(
      JSON.stringify({
        offset: Math.min(a.offset, b.offset),
        ino: a.ino,
        end: Math.max(a.end, b.end)
      })
    )
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
  } catch {
    return
  }
}
export function collapseActivities(items: ClaudeMessage[]): ClaudeMessage[] {
  const result: ClaudeMessage[] = []
  for (const item of items) {
    const previous = result.at(-1)
    const source =
      previous?.role === 'tool' && item.role === 'tool'
        ? combineSources(previous.source, item.source)
        : undefined
    if (source && previous)
      result[result.length - 1] = {
        ...previous,
        source,
        toolCount: (previous.toolCount || 1) + (item.toolCount || 1)
      }
    else result.push(item)
  }
  return result
}
export function pageMessages(pages: ClaudeHistoryPage[]): ClaudeMessage[] {
  return [...new Map(pages.flatMap((page) => page.items).map((item) => [item.id, item])).values()]
}
export function shiftClaudePages(
  pages: ClaudeHistoryPage[],
  page: ClaudeHistoryPage,
  before: boolean
): ClaudeHistoryPage[] {
  if (page.items.every((item) => item.role === 'tool') && pages.length) {
    const index = before ? 0 : pages.length - 1,
      edge = pages[index]
    const combined = before ? [...page.items, ...edge.items] : [...edge.items, ...page.items]
    const items = collapseActivities(combined)
    if (before && page.items.length && edge.items[0]?.role === 'tool' && items[0]?.role === 'tool')
      items[0] = { ...items[0], id: edge.items[0].id }
    return pages.map((item, i) =>
      i !== index
        ? item
        : {
            ...edge,
            items,
            ...(before ? { before: page.before } : { after: page.after })
          }
    )
  }
  return before ? [page, ...pages].slice(0, 3) : [...pages, page].slice(-3)
}
export function mergeMessages(
  first: ClaudeMessage[],
  second: ClaudeMessage[],
  limit = 20
): ClaudeMessage[] {
  const items = collapseActivities(
    [...new Map([...first, ...second].map((item) => [item.id, item])).values()].sort(
      (a, b) => a.at - b.at
    )
  )
  const [start] = claudeMessageWindow(
    items,
    limit,
    Math.max(0, items.filter(isClaudeMessage).length - limit)
  )
  return items.slice(start)
}
export function latestMessages(
  page: ClaudeHistoryPage & { recent?: ClaudeMessage[] }
): ClaudeMessage[] {
  const first = page.items[0]?.at ?? 0,
    ids = new Set(page.items.map((item) => item.id))
  return mergeMessages(
    page.items,
    (page.recent || []).filter((item) => ids.has(item.id) || item.at >= first),
    20
  )
}
