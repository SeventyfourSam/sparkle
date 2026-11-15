import type { CodexRecord } from '../../../shared/codex-web'
import { HISTORY_WINDOW, previewItem, visibleNarrative } from '../../../shared/codex-web-history'
type Call = (method: string, params: CodexRecord) => Promise<CodexRecord>
type Position = { cursor: string | null; skip: number; direction: 'asc' | 'desc' }
const prefix = 'sparkle-history:'
const encode = (value: Position): string =>
  prefix + Buffer.from(JSON.stringify(value)).toString('base64url')
function position(cursor?: string): Position {
  if (!cursor) return { cursor: null, skip: 0, direction: 'desc' }
  try {
    if (!cursor.startsWith(prefix) || cursor.length > 16384) throw new Error()
    const value = JSON.parse(Buffer.from(cursor.slice(prefix.length), 'base64url').toString())
    if (
      (value.cursor !== null && typeof value.cursor !== 'string') ||
      ![0, 1].includes(value.skip) ||
      !['asc', 'desc'].includes(value.direction)
    )
      throw new Error()
    return value
  } catch {
    throw new Error('历史位置已过期，请重新同步会话')
  }
}

// Locate the frozen live window's boundaries once, then return a single older
// batch. The browser never replaces its view with intermediate recent pages.
export async function anchoredHistory(
  call: Call,
  threadId: string,
  before: CodexRecord,
  end: CodexRecord
): Promise<CodexRecord> {
  for (const item of [before, end])
    if (
      typeof item?.turnId !== 'string' ||
      typeof item?.itemId !== 'string' ||
      !item.turnId ||
      !item.itemId ||
      item.turnId.length > 200 ||
      item.itemId.length > 300
    )
      throw new Error('历史条目标识无效')
  const positions = new Map<string, { cursor: string; limit: number }>()
  const key = (item: CodexRecord): string => JSON.stringify([item.turnId, item.itemId])
  let cursor: string | null = null
  const deadline = Date.now() + 10000
  const visited = new Set<string | null>()
  for (let pageIndex = 0; pageIndex < 32; pageIndex++) {
    if (Date.now() > deadline) throw new Error('定位当前历史超时，请稍后重试')
    if (visited.has(cursor)) throw new Error('历史分页位置重复，请重新同步会话')
    visited.add(cursor)
    const page = await call('thread/items/list', {
      threadId,
      cursor,
      limit: 40,
      sortDirection: 'desc'
    })
    if (!Array.isArray(page.data)) throw new Error('当前 Codex 未提供分页条目')
    for (let i = 0; i < page.data.length; i++) {
      const entry = page.data[i],
        id = JSON.stringify([entry.turnId, entry.item?.id])
      if ((id === key(before) || id === key(end)) && page.backwardsCursor)
        positions.set(id, { cursor: page.backwardsCursor, limit: i + 1 })
    }
    if (positions.has(key(before)) && positions.has(key(end))) break
    if (!page.nextCursor) break
    cursor = page.nextCursor
  }
  const boundary = async (item: CodexRecord): Promise<string | null> => {
    const found = positions.get(key(item))
    if (!found) throw new Error('暂时无法定位当前历史，请稍后重试')
    const page = await call('thread/items/list', { threadId, ...found, sortDirection: 'desc' })
    return page.nextCursor || null
  }
  const older = await boundary(before),
    newer = await boundary(end)
  const result = older
    ? await recentHistory(call, threadId, encode({ cursor: older, skip: 0, direction: 'desc' }))
    : { data: [], olderCursor: null, newerCursor: null }
  return {
    ...result,
    windowOlderCursor: older ? encode({ cursor: older, skip: 0, direction: 'desc' }) : null,
    windowNewerCursor: encode({ cursor: newer, skip: newer ? 0 : 1, direction: 'asc' })
  }
}

export async function recentHistory(
  call: Call,
  threadId: string,
  cursor?: string
): Promise<CodexRecord> {
  const start = position(cursor)
  const { data: shells = [] } = await call('thread/turns/list', {
    threadId,
    limit: 10,
    sortDirection: 'desc',
    itemsView: 'summary'
  })
  const entries: { turnId: string; item: CodexRecord }[] = []
  const direction = start.direction
  let current = start.cursor,
    skip = start.skip,
    continuation: string | null = null,
    reverse: string | null = null
  let visible = 0,
    historyNotice: string | undefined
  const visited = new Set<string | null>()
  try {
    for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
      if (visited.has(current)) throw new Error('历史分页位置重复，请重新同步会话')
      visited.add(current)
      const params = { threadId, cursor: current, limit: 40, sortDirection: direction }
      const page = await call('thread/items/list', params)
      if (!Array.isArray(page.data)) throw new Error('当前 Codex 未提供分页条目')
      if (page.nextCursor && visited.has(page.nextCursor))
        throw new Error('历史分页位置重复，请重新同步会话')
      // The inclusive first-item cursor also works in the reverse direction.
      // A skipped anchor belongs to the adjacent page, so include it on reversal.
      if (reverse === null && page.data.length > skip && page.backwardsCursor)
        reverse = encode({
          cursor: page.backwardsCursor,
          skip: skip ? 0 : 1,
          direction: direction === 'desc' ? 'asc' : 'desc'
        })
      let index = skip
      for (; index < page.data.length; index++) {
        const entry = page.data[index]
        if (!entry?.item?.id || typeof entry.turnId !== 'string') continue
        const item = previewItem(entry.item, entry.turnId)
        entries.push({ turnId: entry.turnId, item })
        if (visibleNarrative(item)) visible++
        if (visible >= HISTORY_WINDOW) {
          index++
          break
        }
      }
      if (index < page.data.length) {
        // Obtain a native exclusive cursor for the exact consumed boundary.
        // Reuse the immutable inclusive anchor, never a moving latest-page offset.
        if (!page.backwardsCursor) throw new Error('Codex 未返回稳定的历史位置')
        const boundary = await call('thread/items/list', {
          ...params,
          cursor: page.backwardsCursor,
          limit: index
        })
        if (!boundary.nextCursor) throw new Error('Codex 未返回历史续页位置')
        continuation = encode({ cursor: boundary.nextCursor, skip: 0, direction })
      } else
        continuation = page.nextCursor
          ? encode({ cursor: page.nextCursor, skip: 0, direction })
          : null
      if (visible >= HISTORY_WINDOW || !page.nextCursor) break
      current = page.nextCursor
      skip = 0
    }
  } catch (error) {
    if (!/method not found|unknown variant|unknown method|未提供分页/i.test(String(error)))
      throw error
    historyNotice = '当前 Codex 仅提供回合摘要；详细历史需要支持分页条目的版本。'
    entries.length = 0
    continuation = null
    reverse = null
    for (const turn of shells)
      for (const item of [...(turn.items || [])].reverse()) {
        if (entries.filter((entry) => visibleNarrative(entry.item)).length >= HISTORY_WINDOW) break
        entries.push({ turnId: turn.id, item: previewItem(item, turn.id) })
      }
  }
  const turns = new Map<string, CodexRecord>()
  const metadata = new Map<string, CodexRecord>(shells.map((turn: CodexRecord) => [turn.id, turn]))
  for (const entry of direction === 'desc' ? [...entries].reverse() : entries) {
    const turn = turns.get(entry.turnId) || {
      ...metadata.get(entry.turnId),
      id: entry.turnId,
      status: metadata.get(entry.turnId)?.status || 'completed',
      items: []
    }
    turns.set(entry.turnId, turn)
    if (!turn.items.some((item: CodexRecord) => item.id === entry.item.id))
      turn.items.push(entry.item)
  }
  const active = shells.find((turn: CodexRecord) => turn.status === 'inProgress')
  const olderCursor = direction === 'desc' ? continuation : reverse
  const newerCursor = direction === 'asc' ? continuation : reverse
  return {
    data: [...turns.values()],
    nextCursor: olderCursor,
    olderCursor,
    newerCursor,
    activeTurn: active ? { ...active, items: [] } : null,
    historyNotice
  }
}
