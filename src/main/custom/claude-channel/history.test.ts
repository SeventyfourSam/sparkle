import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { claudeHistory, claudeHistoryDetail } from './history'
import {
  latestMessages,
  mergeMessages,
  pageMessages,
  shiftClaudePages
} from '../../../renderer/src/custom/claude-channel/window-state'
import type { ClaudeHistoryPage } from '../../../shared/claude-channel'
import { claudeMessageWindow, isClaudeMessage } from '../../../shared/claude-channel'

test('history groups native tools before paging and defers details, while filtering CLI bookkeeping', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sparkle grouped history '))
  const file = join(directory, 'session.jsonl')
  let sequence = 0
  const line = (type: string, content: unknown) =>
    JSON.stringify({
      uuid: `row:${sequence++}`,
      type,
      timestamp: new Date(sequence * 1000).toISOString(),
      message: { content }
    })
  try {
    const text = 'Full reply ' + 'long text '.repeat(1800)
    await writeFile(
      file,
      [
        line('user', 'A question'),
        line('assistant', 'Progress stays visible'),
        ...Array.from({ length: 45 }, (_, i) =>
          line('assistant', [{ type: 'tool_use', name: 'Read', input: { path: `src/${i}.ts` } }])
        ),
        line('user', '<local-command-caveat>Internal boilerplate</local-command-caveat>'),
        line('user', '<command-name>/model</command-name><command-args>opus</command-args>'),
        line(
          'user',
          '<local-command-stdout>\u001b[32mSelected opus\u001b[0m</local-command-stdout>'
        ),
        line('assistant', text)
      ].join('\n') + '\n'
    )
    const page = await claudeHistory(file)
    assert.equal(page.items.length, 4)
    assert.equal(page.before, null)
    assert.equal(page.after, null)
    const activity = page.items[2]
    assert.equal(activity.role, 'tool')
    assert.equal(activity.toolCount, 47)
    assert.equal(activity.detail, undefined)
    assert(!JSON.stringify(page).includes('Internal boilerplate'))
    assert(!JSON.stringify(page).includes('src/44.ts'))
    let detail = await claudeHistoryDetail(file, activity.source)
    assert.equal(detail.items.length, 20)
    assert(detail.items[0].detail?.includes('src/0.ts'))
    assert(detail.next)
    detail = await claudeHistoryDetail(file, detail.next)
    assert.equal(detail.items.length, 20)
    detail = await claudeHistoryDetail(file, detail.next)
    assert.equal(detail.items.length, 7)
    assert.equal(detail.items.at(-1)?.detail, 'Selected opus')
    assert.equal(detail.next, undefined)
    const reply = page.items.at(-1)!
    assert.equal(reply.truncated, true)
    assert.equal((await claudeHistoryDetail(file, reply.source)).items[0].text, text)
    await assert.rejects(claudeHistoryDetail(file, page.items[0].source!.slice(5)))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('history cursors traverse both directions without dropping boundary records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sparkle history cursors '))
  const file = join(directory, 'session.jsonl')
  try {
    await writeFile(
      file,
      Array.from({ length: 35 }, (_, i) =>
        JSON.stringify({
          uuid: `message:${i}`,
          type: 'assistant',
          message: { content: `Message ${i}` }
        })
      ).join('\n') + '\n'
    )
    const latest = await claudeHistory(file)
    const previous = await claudeHistory(file, { before: latest.before })
    const forward = await claudeHistory(file, { after: previous.after })
    assert.deepEqual(
      forward.items.map((item) => item.id),
      latest.items.map((item) => item.id)
    )
    assert.equal(previous.items[0].id, 'message:15')
    const oldest = await claudeHistory(file, { before: previous.before })
    assert.equal(oldest.items[0].id, 'message:5')
    const first = await claudeHistory(file, { before: oldest.before })
    assert.equal(first.items.length, 5)
    assert.equal(first.before, null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('tools consume neither the ten-message fetch quota nor the twenty-message render quota', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sparkle narrative quota '))
  const file = join(directory, 'session.jsonl')
  try {
    await writeFile(
      file,
      Array.from({ length: 35 }, (_, i) => [
        { uuid: `message:${i}`, type: 'assistant', message: { content: `Progress ${i}` } },
        {
          uuid: `tool:${i}`,
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Read', input: { path: 'file.ts' } }] }
        }
      ])
        .flat()
        .map((item) => JSON.stringify(item))
        .join('\n') + '\n'
    )
    const latest = await claudeHistory(file)
    assert.equal(latest.items.filter(isClaudeMessage).length, 10)
    assert.equal(latest.items.length, 20)
    assert.equal(latest.items[0].id, 'message:25')
    const previous = await claudeHistory(file, { before: latest.before })
    assert.equal(previous.items.filter(isClaudeMessage).length, 10)
    const oldest = await claudeHistory(file, { before: previous.before })
    const all = [...oldest.items, ...previous.items, ...latest.items]
    const live = mergeMessages(all, [])
    assert.equal(live.filter(isClaudeMessage).length, 20)
    assert.equal(live.length, 40)
    assert.equal(live[0].id, 'message:15')
    const [start, end] = claudeMessageWindow(all, 20)
    const window = all.slice(start, end)
    assert.equal(window.filter(isClaudeMessage).length, 20)
    assert.equal(window.length, 40)
    const forward = await claudeHistory(file, { after: previous.after })
    assert.deepEqual(forward.items, latest.items)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('tool-only and empty history pages preserve readable messages and the existing scroll anchor', () => {
  const source = (offset: number, end: number) =>
    Buffer.from(JSON.stringify({ offset, ino: 1, end })).toString('base64url')
  const body = { id: 'body', role: 'assistant' as const, text: 'Readable reply', at: 100 }
  let pages: ClaudeHistoryPage[] = [
    {
      items: [{ id: 'anchor', role: 'tool', text: 'Tools', at: 90, source: source(90, 100) }, body],
      before: source(90, 90),
      after: null
    }
  ]
  for (let i = 8; i >= 0; i--) {
    pages = shiftClaudePages(
      pages,
      {
        items: [
          {
            id: `tools:${i}`,
            role: 'tool',
            text: 'Tools',
            at: i * 10,
            source: source(i * 10, i * 10 + 10)
          }
        ],
        before: i ? source(i * 10, i * 10) : null,
        after: null
      },
      true
    )
  }
  pages = shiftClaudePages(pages, { items: [], before: null, after: null }, true)
  assert.equal(pages.length, 1)
  const items = pageMessages(pages)
  assert.equal(items.length, 2)
  assert.equal(items[0].id, 'anchor')
  assert.equal(items[0].toolCount, 10)
  assert.equal(items[1], body)
  assert.deepEqual(JSON.parse(Buffer.from(items[0].source!, 'base64url').toString()), {
    offset: 0,
    ino: 1,
    end: 100
  })
  assert.deepEqual(
    latestMessages({
      items: [body],
      recent: [{ ...body, id: 'old', at: 5 }],
      before: null,
      after: null
    }),
    [body]
  )
})

test('automatic compact summaries are lazy activities, not user messages or replies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sparkle compact quota '))
  const file = join(directory, 'session.jsonl')
  try {
    await writeFile(
      file,
      Array.from({ length: 35 }, (_, i) => [
        {
          uuid: `message:${i}`,
          type: i % 2 ? 'assistant' : 'user',
          message: { content: `Discuss compact ${i}` }
        },
        { uuid: `boundary:${i}`, type: 'system', subtype: 'compact_boundary' },
        {
          uuid: `compact:${i}`,
          type: 'user',
          isCompactSummary: true,
          isVisibleInTranscriptOnly: true,
          message: { content: `Private compact summary ${i}` }
        }
      ])
        .flat()
        .map((item) => JSON.stringify(item))
        .join('\n') + '\n'
    )
    const latest = await claudeHistory(file)
    assert.equal(latest.items.filter(isClaudeMessage).length, 10)
    assert.equal(latest.items[0].id, 'message:25')
    assert(
      latest.items.filter(isClaudeMessage).every((item) => item.text.startsWith('Discuss compact'))
    )
    assert(!JSON.stringify(latest).includes('Private compact summary'))
    const compact = latest.items.find((item) => item.role === 'tool')!
    assert(compact)
    assert.equal(compact.detail, undefined)
    const detail = await claudeHistoryDetail(file, compact.source)
    assert.equal(detail.items[0].role, 'tool')
    assert.equal(detail.items[0].text, '上下文压缩')
    assert.equal(detail.items[0].detail, 'Private compact summary 25')
    const previous = await claudeHistory(file, { before: latest.before })
    assert.equal(previous.items.filter(isClaudeMessage).length, 10)
    const oldest = await claudeHistory(file, { before: previous.before })
    const all = [...oldest.items, ...previous.items, ...latest.items]
    const live = mergeMessages(all, [])
    assert.equal(live.filter(isClaudeMessage).length, 20)
    assert.equal(live[0].id, 'message:15')
    const [start, end] = claudeMessageWindow(all, 20)
    assert.equal(all.slice(start, end).filter(isClaudeMessage).length, 20)
    assert.deepEqual((await claudeHistory(file, { after: previous.after })).items, latest.items)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('latest history crosses a tool-only tail larger than four MiB and keeps ten messages as it grows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sparkle long tool tail '))
  const file = join(directory, 'session.jsonl')
  const record = (value: object) => JSON.stringify(value) + '\n'
  const message = (i: number) => ({
    uuid: `message:${i}`,
    type: 'assistant',
    message: { content: `Progress ${i}` }
  })
  const tool = (i: number) => ({
    uuid: `tool:${i}`,
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Read', input: { path: 'file.ts' } }] }
  })
  try {
    await writeFile(
      file,
      Array.from({ length: 25 }, (_, i) => record(message(i))).join('') +
        record(tool(0)) +
        record({ type: 'api-request-blob', data: 'x'.repeat(6 * 1024 * 1024) }) +
        record({
          uuid: 'compact',
          type: 'user',
          isCompactSummary: true,
          message: { content: 'A generated summary' }
        }) +
        Array.from({ length: 80 }, () =>
          record({ type: 'file-history-snapshot', data: 'y'.repeat(64 * 1024) })
        ).join('') +
        record(tool(1))
    )
    const latest = await claudeHistory(file)
    assert.equal(latest.items.filter(isClaudeMessage).length, 10)
    assert.equal(latest.items[0].id, 'message:15')
    assert.equal(latest.items.at(-1)?.toolCount, 3)
    assert.equal(latest.after, null)
    assert.equal(latest.items.at(-1)?.detail, undefined)
    const detail = await claudeHistoryDetail(file, latest.items.at(-1)?.source)
    assert.equal(detail.items.length, 3)
    assert.equal(detail.items[0].role, 'tool')
    assert.equal(detail.next, undefined)
    const previous = await claudeHistory(file, { before: latest.before })
    assert.equal(previous.items.filter(isClaudeMessage).length, 10)
    assert.deepEqual((await claudeHistory(file, { after: previous.after })).items, latest.items)
    await appendFile(file, record(tool(2)))
    const toolsUpdated = await claudeHistory(file)
    assert.equal(toolsUpdated.items.filter(isClaudeMessage).length, 10)
    assert.equal(toolsUpdated.items.at(-1)?.toolCount, 4)
    assert.equal(
      latest.items.at(-1)?.toolCount,
      3,
      'incremental reads must not mutate an already delivered page'
    )
    await appendFile(file, record(message(25)) + record(tool(3)))
    const updated = await claudeHistory(file)
    assert.equal(updated.items.filter(isClaudeMessage).length, 10)
    assert.equal(updated.items[0].id, 'message:16')
    assert.equal(updated.items.filter(isClaudeMessage).at(-1)?.id, 'message:25')
    const partial = record(message(26))
    await appendFile(file, partial.slice(0, -8))
    const unfinished = await claudeHistory(file)
    assert.deepEqual(unfinished.items, updated.items)
    assert(unfinished.after)
    await appendFile(file, partial.slice(-8))
    const completed = await claudeHistory(file)
    assert.equal(completed.items.filter(isClaudeMessage).length, 10)
    assert.equal(completed.items[0].id, 'message:17')
    assert.equal(completed.items.at(-1)?.id, 'message:26')
    assert.equal(completed.after, null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('incremental latest history rejects a rewritten transcript even when its inode and larger size remain', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sparkle rewritten transcript '))
  const file = join(directory, 'session.jsonl')
  try {
    await writeFile(
      file,
      JSON.stringify({ uuid: 'old', type: 'user', message: { content: 'Old question' } }) + '\n'
    )
    await claudeHistory(file)
    await writeFile(
      file,
      JSON.stringify({
        uuid: 'new',
        type: 'user',
        message: { content: 'New question '.repeat(30) }
      }) + '\n'
    )
    const page = await claudeHistory(file)
    assert.deepEqual(
      page.items.map((item) => item.id),
      ['new']
    )
    assert.equal(page.before, null)
    assert.equal(page.after, null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('collapsed terminal commands carry only activity metadata until expanded', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sparkle terminal metadata '))
  const file = join(directory, 'session.jsonl')
  try {
    await writeFile(
      file,
      [
        {
          uuid: 'command',
          type: 'user',
          message: { content: '<command-name>/compact</command-name>' }
        },
        {
          uuid: 'output',
          type: 'user',
          message: {
            content: '<local-command-stdout>Private terminal output</local-command-stdout>'
          }
        }
      ]
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n'
    )
    const page = await claudeHistory(file)
    assert.equal(page.items.length, 1)
    assert.equal(page.items[0].role, 'tool')
    assert.equal(page.items[0].detail, undefined)
    assert(!JSON.stringify(page).includes('Private terminal output'))
    const detail = await claudeHistoryDetail(file, page.items[0].source)
    assert.equal(detail.items[1].detail, 'Private terminal output')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
