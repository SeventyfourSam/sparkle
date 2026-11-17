import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { stripVTControlCharacters } from 'node:util'
import type { ClaudeHistoryPage, ClaudeMessage } from '../../../shared/claude-channel'
import { claudeMessageWindow, isClaudeMessage } from '../../../shared/claude-channel'
import type { CodexRecord } from '../../../shared/codex-web'
import { transcriptLines, type TranscriptLine } from './transcript-lines'

export const replyId = (messageId: string, text: string): string =>
  `reply:${messageId}:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`
const encode = (offset: number, ino: number, end?: number): string =>
  Buffer.from(JSON.stringify({ offset, ino, ...(end === undefined ? {} : { end }) })).toString(
    'base64url'
  )
const clip = (value: unknown, length = 12000): string => String(value || '').slice(0, length)
type Row = { start: number; end: number; message: ClaudeMessage }
type CachedHistory = {
  version: string
  ino: number
  size: number
  readEnd: number
  fingerprint: Buffer
  rows: Row[]
  page: ClaudeHistoryPage
}
const cache = new Map<string, CachedHistory>()

function entry(value: CodexRecord, offset: number, full = false): ClaudeMessage | undefined {
  if (!['user', 'assistant'].includes(value.type) || !value.message) return
  const content =
    typeof value.message.content === 'string'
      ? [{ type: 'text', text: value.message.content }]
      : value.message.content
  if (!Array.isArray(content)) return
  let text = content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
  const id = String(value.uuid || value.message.id || `row:${offset}`)
  const at = Number.isFinite(Date.parse(value.timestamp)) ? Date.parse(value.timestamp) : 0
  const base = { id, at, ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}) }
  // These are terminal bookkeeping records, not messages from the user or model.
  if (value.isCompactSummary === true)
    return {
      ...base,
      role: 'tool',
      text: '上下文压缩',
      toolCount: 1,
      ...(full ? { detail: clip(text) } : {})
    }
  if (/^\s*<local-command-caveat>/.test(text)) {
    text = text.replace(/^\s*<local-command-caveat>[\s\S]*?<\/local-command-caveat>\s*/, '')
    if (!text.trim()) return
  }
  const command = text.match(
    /^\s*(?:<command-message>[\s\S]*?<\/command-message>\s*)?<command-name>([\s\S]*?)<\/command-name>/
  )
  const output = text.match(/^\s*<local-command-stdout>([\s\S]*?)<\/local-command-stdout>\s*$/)
  if (command || output) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] || ''
    return {
      ...base,
      role: 'tool',
      text: command ? `${command[1]} ${args}`.trim() : '终端输出',
      ...(full
        ? { detail: clip(stripVTControlCharacters(output ? output[1] : `${command![1]} ${args}`)) }
        : {}),
      toolCount: 1
    }
  }
  const tools = content.filter((part) => part.type === 'tool_use')
  const results = content.filter((part) => part.type === 'tool_result')
  const reply = tools.find(
    (part) =>
      part.name === 'mcp__sparkle__reply' &&
      typeof part.input?.text === 'string' &&
      typeof part.input?.message_id === 'string'
  )
  const channel = text.match(
    /^<channel\b[^>]*\bmessage_id="([a-f\d-]{36})"[^>]*>\s*([\s\S]*?)\s*<\/channel>$/
  )
  if (reply)
    return {
      ...base,
      id: replyId(reply.input.message_id, reply.input.text),
      role: 'assistant',
      text: full ? reply.input.text : clip(reply.input.text, 32000),
      truncated: reply.input.text.length > 32000
    }
  if (text.trim()) {
    text = channel ? channel[2] : text
    return {
      ...base,
      id: channel ? `send:${channel[1]}` : id,
      role: value.type,
      text: full ? text : clip(text),
      truncated: text.length > 12000,
      ...(tools.length
        ? { hasTools: true, ...(full ? { detail: clip(JSON.stringify(tools)) } : {}) }
        : {})
    }
  }
  if (tools.length || results.length)
    return {
      ...base,
      role: 'tool',
      toolCount: tools.length || results.length,
      text: tools.length
        ? tools
            .map((tool) => String(tool.name || '工具调用'))
            .join('、')
            .slice(0, 300)
        : '工具结果',
      ...(full ? { detail: clip(JSON.stringify(tools.length ? tools : results)) } : {})
    }
  return undefined
}

function historyRow(line: TranscriptLine, ino: number): Row | undefined {
  if (!line.bytes?.length) return
  let message: ClaudeMessage | undefined
  try {
    message = entry(JSON.parse(line.bytes.toString('utf8')), line.start)
  } catch {
    return
  }
  if (!message) return
  return {
    start: line.start,
    end: line.end,
    message: {
      ...message,
      ...(message.role === 'tool' ? { id: `tools:${message.id}`, text: '工具与终端活动' } : {}),
      source: encode(line.start, ino, line.end)
    }
  }
}

function addRow(rows: Row[], row: Row, ino: number, forward: boolean): void {
  const duplicate = rows.findIndex((item) => item.message.id === row.message.id)
  if (duplicate >= 0) {
    if (!forward) return
    rows.splice(duplicate, 1)
  }
  const edge = forward ? rows.at(-1) : rows[0]
  if (row.message.role === 'tool' && edge?.message.role === 'tool') {
    const first = forward ? edge : row,
      last = forward ? row : edge
    const merged = {
      start: first.start,
      end: last.end,
      message: {
        ...first.message,
        toolCount: (first.message.toolCount || 1) + (last.message.toolCount || 1),
        source: encode(first.start, ino, last.end)
      }
    }
    rows[forward ? rows.length - 1 : 0] = merged
  } else if (forward) rows.push(row)
  else rows.unshift(row)
}
function decode(token: unknown, size: number, ino: number): { offset: number; end?: number } {
  if (typeof token !== 'string' || token.length > 200) throw new Error('历史位置无效')
  let value
  try {
    value = JSON.parse(Buffer.from(token, 'base64url').toString())
  } catch {
    throw new Error('历史位置无效')
  }
  if (
    !Number.isSafeInteger(value.offset) ||
    value.offset < 0 ||
    value.offset > size ||
    value.ino !== ino
  )
    throw new Error('历史记录已变化，请回到最新内容重新同步')
  return value
}
// Stop on message count rather than bytes. Only one chunk and ten message previews
// are retained; subsequent latest reads scan appended records rather than the same tail.
export async function claudeHistory(
  file: string | undefined,
  query: { before?: unknown; after?: unknown } = {}
): Promise<ClaudeHistoryPage> {
  if (!file) return { items: [], before: null, after: null }
  let handle
  try {
    handle = await open(file, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { items: [], before: null, after: null }
    throw error
  }
  try {
    const info = await handle.stat(),
      forward = !!query.after,
      token = query.before ?? query.after
    const version = `${info.ino}:${info.size}:${info.mtimeMs}`
    const cached = token == null ? cache.get(file) : undefined
    if (cached?.version === version) return cached.page
    const position = token == null ? info.size : decode(token, info.size, info.ino).offset
    let incremental = false
    if (cached && cached.ino === info.ino && info.size > cached.size && cached.readEnd) {
      const previous = Buffer.alloc(cached.fingerprint.length)
      await handle.read(previous, 0, previous.length, cached.readEnd - previous.length)
      incremental = previous.equals(cached.fingerprint)
    }
    let selected: Row[] = incremental ? [...cached!.rows] : []
    let count = selected.filter((row) => isClaudeMessage(row.message)).length
    let readEnd = incremental ? cached!.readEnd : forward ? position : 0
    let reachedStart = !forward && position === 0
    let first = incremental ? (cached!.page.before ? selected[0]?.start || 0 : 0) : position
    let last = readEnd
    const scanningForward = forward || incremental
    for await (const line of transcriptLines(
      handle,
      scanningForward ? (incremental ? cached!.readEnd : position) : 0,
      scanningForward ? info.size : position,
      scanningForward
    )) {
      const row = historyRow(line, info.ino)
      if (forward && row && isClaudeMessage(row.message) && count >= 10) {
        last = line.start
        break
      }
      if (scanningForward) readEnd = line.end
      else if (!readEnd) readEnd = line.end
      last = scanningForward ? readEnd : position === info.size ? readEnd : position
      if (!scanningForward) reachedStart = line.start === 0
      if (row) {
        addRow(selected, row, info.ino, scanningForward)
        count = selected.filter((item) => isClaudeMessage(item.message)).length
        if (incremental && count > 10) {
          const [start] = claudeMessageWindow(
            selected.map((item) => item.message),
            10,
            count - 10
          )
          selected = selected.slice(start)
          count = 10
          first = selected[0].start
        }
        if (!scanningForward && count >= 10) break
      }
    }
    if (!incremental) first = forward ? position : reachedStart ? 0 : selected[0]?.start || 0
    const page: ClaudeHistoryPage = {
      items: selected.map((item) => item.message),
      before: first > 0 ? encode(first, info.ino) : null,
      after: last < info.size ? encode(last, info.ino) : null
    }
    if (token == null) {
      const fingerprint = Buffer.alloc(Math.min(128, readEnd))
      await handle.read(fingerprint, 0, fingerprint.length, readEnd - fingerprint.length)
      cache.delete(file)
      cache.set(file, {
        version,
        ino: info.ino,
        size: info.size,
        readEnd,
        fingerprint,
        rows: selected,
        page
      })
      while (cache.size > 16) cache.delete(cache.keys().next().value!)
    }
    return page
  } finally {
    await handle.close()
  }
}

export async function claudeHistoryDetail(
  file: string | undefined,
  source: unknown
): Promise<{ items: ClaudeMessage[]; next?: string }> {
  if (!file) throw new Error('会话历史尚未就绪')
  const handle = await open(file, 'r')
  try {
    const info = await handle.stat(),
      range = decode(source, info.size, info.ino)
    if (!Number.isSafeInteger(range.end) || range.end! < range.offset || range.end! > info.size)
      throw new Error('历史详情位置无效')
    const result: ClaudeMessage[] = []
    let next = range.offset
    for await (const line of transcriptLines(handle, range.offset, range.end!, true)) {
      next = line.end
      if (!line.bytes?.length) continue
      try {
        const message = entry(JSON.parse(line.bytes.toString('utf8')), line.start, true)
        if (message) result.push(message)
      } catch {
        /* Skip metadata. */
      }
      if (result.length >= 20) break
    }
    if (!result.length && range.end! > range.offset)
      throw new Error('没有可预览的记录，或单条记录过大')
    return {
      items: result,
      ...(next < range.end! ? { next: encode(next, info.ino, range.end) } : {})
    }
  } finally {
    await handle.close()
  }
}
