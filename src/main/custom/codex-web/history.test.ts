import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CodexRecord } from '../../../shared/codex-web'
import {
  boundedDetail,
  previewItem,
  TOOL_OUTPUT_LIMIT,
  visibleNarrative
} from '../../../shared/codex-web-history'
import { LiveItemCache, recentHistory } from './history'
import { anchoredHistory } from './history-pages'
import { HistoryScrollGate } from '../../../renderer/src/custom/codex-web/history-scroll-gate'

function historyFixture(items: CodexRecord[], shells: CodexRecord[] = []) {
  const entries = items.map((item) => ({ turnId: 'turn', item }))
  const calls: { method: string; params: CodexRecord }[] = []
  const call = async (method: string, params: CodexRecord): Promise<CodexRecord> => {
    calls.push({ method, params })
    if (method === 'thread/turns/list') return { data: shells }
    assert.equal(method, 'thread/items/list')
    const ordered = params.sortDirection === 'asc' ? [...entries].reverse() : entries
    const start = params.cursor
      ? ordered.findIndex((entry) => entry.item.id === params.cursor.slice(1)) +
        (params.cursor[0] === '>' ? 1 : 0)
      : 0
    const data = ordered.slice(start, start + params.limit)
    return {
      data,
      backwardsCursor: data.length ? `=${data[0].item.id}` : null,
      nextCursor: start + data.length < entries.length ? `>${data.at(-1)!.item.id}` : null
    }
  }
  return { call, calls, entries }
}

test('live-window anchors return one adjacent batch with exact cursors for retained messages', async () => {
  const f = historyFixture(
    Array.from({ length: 100 }, (_, i) => ({
      id: `i${i}`,
      type: 'agentMessage',
      text: `progress${i}`
    }))
  )
  const page = await anchoredHistory(
    f.call,
    'thread',
    { turnId: 'turn', itemId: 'i20' },
    { turnId: 'turn', itemId: 'i11' }
  )
  const ids = (page: CodexRecord): string[] =>
    page.data.flatMap((turn: CodexRecord) => turn.items).map((item: CodexRecord) => item.id)
  assert.deepEqual(
    ids(page),
    Array.from({ length: 10 }, (_, i) => `i${30 - i}`)
  )
  const newer = await recentHistory(f.call, 'thread', page.windowNewerCursor)
  assert.deepEqual(
    ids(newer),
    Array.from({ length: 10 }, (_, i) => `i${10 - i}`)
  )
  await assert.rejects(
    anchoredHistory(
      f.call,
      'thread',
      { turnId: 'turn', itemId: 'not-persisted' },
      { turnId: 'turn', itemId: 'i11' }
    ),
    /无法定位/
  )
})

test('scroll gate holds through loading and ignores remaining wheel/touch inertia until a new gesture', () => {
  const gate = new HistoryScrollGate()
  assert.equal(gate.wheel(0), true)
  assert.equal(gate.begin(), true)
  for (let time = 10; time < 200; time += 10) {
    assert.equal(gate.wheel(time), false)
    assert.equal(gate.begin(), false)
  }
  assert.equal(gate.touchStart(), false)
  gate.complete()
  assert.equal(gate.wheel(210), false)
  assert.equal(gate.begin(), false)
  assert.equal(gate.wheel(500), true)
  assert.equal(gate.begin(), true)
  gate.complete()
  assert.equal(gate.touchStart(), true)
  assert.equal(gate.begin(), true)
  assert.equal(gate.touchStart(), false)
  gate.complete()
  assert.equal(gate.allowed, false)
  gate.reset()
  assert.equal(gate.allowed, true)
})

test('history fetches ten visible entries, strips tool payloads, and pages without holes while new items arrive', async () => {
  const items = Array.from({ length: 55 }, (_, i) =>
    i % 2
      ? {
          id: `i${i}`,
          type: 'commandExecution',
          aggregatedOutput: 'secret output'.repeat(1000),
          command: 'build'
        }
      : { id: `i${i}`, type: 'agentMessage', text: `progress ${i}`, phase: 'commentary' }
  )
  const f = historyFixture(items)
  const first = await recentHistory(f.call, 'thread')
  assert.equal(
    first.data.flatMap((turn: CodexRecord) => turn.items).filter(visibleNarrative).length,
    10
  )
  assert.equal(JSON.stringify(first).includes('secret output'), false)
  assert.equal(f.calls[0].params.itemsView, 'summary')
  assert.ok(f.calls.every((call) => call.params.itemsView !== 'full'))
  f.entries.unshift({ turnId: 'turn', item: { id: 'new', type: 'agentMessage', text: 'new' } })
  const ids = first.data
    .flatMap((turn: CodexRecord) => turn.items)
    .map((item: CodexRecord) => item.id)
  let cursor = first.nextCursor
  while (cursor) {
    const page = await recentHistory(f.call, 'thread', cursor)
    ids.push(
      ...page.data.flatMap((turn: CodexRecord) => turn.items).map((item: CodexRecord) => item.id)
    )
    cursor = page.nextCursor
  }
  assert.equal(new Set(ids).size, 55)
  assert.equal(ids.length, 55)
  assert.equal(ids.includes('new'), false)
})

test('bidirectional cursors return adjacent messages without gaps or duplicate boundary items', async () => {
  const f = historyFixture(
    Array.from({ length: 85 }, (_, i) => ({
      id: `i${i}`,
      type: i % 3 ? 'agentMessage' : 'commandExecution',
      text: i % 3 ? `message${i}` : undefined
    }))
  )
  const first = await recentHistory(f.call, 'thread')
  const second = await recentHistory(f.call, 'thread', first.olderCursor)
  const third = await recentHistory(f.call, 'thread', second.olderCursor)
  const forward = await recentHistory(f.call, 'thread', third.newerCursor)
  const ids = (page: CodexRecord): string[] =>
    page.data.flatMap((turn: CodexRecord) => turn.items).map((item: CodexRecord) => item.id)
  const messages = (page: CodexRecord): string[] =>
    page.data
      .flatMap((turn: CodexRecord) => turn.items)
      .filter(visibleNarrative)
      .map((item: CodexRecord) => item.id)
  assert.deepEqual(messages(forward), messages(second))
  const latest = await recentHistory(f.call, 'thread', forward.newerCursor)
  assert.deepEqual(messages(latest), messages(first))
  const end = await recentHistory(f.call, 'thread', latest.newerCursor)
  assert.equal(end.newerCursor, null)
  assert.deepEqual([...ids(forward), ...ids(latest), ...ids(end)], [...ids(second), ...ids(first)])
})

test('tool-only bursts are bounded and running state is separate from visible messages', async () => {
  const f = historyFixture(
    Array.from({ length: 300 }, (_, i) => ({
      id: `i${i}`,
      type: 'fileChange',
      changes: [{ diff: 'large'.repeat(1000) }]
    })),
    [
      {
        id: 'turn',
        status: 'inProgress',
        items: [{ id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'question' }] }]
      },
      {
        id: 'answer-turn',
        status: 'completed',
        items: [{ id: 'answer', type: 'agentMessage', text: 'answer' }]
      }
    ]
  )
  const result = await recentHistory(f.call, 'thread')
  assert.equal(f.calls.filter((call) => call.method === 'thread/items/list').length, 4)
  assert.ok(result.nextCursor)
  const entries = result.data.flatMap((turn: CodexRecord) => turn.items)
  assert.equal(entries.filter((item: CodexRecord) => item.type === 'fileChange').length, 160)
  assert.equal(entries.filter((item: CodexRecord) => item.webPinned).length, 0)
  assert.equal(result.activeTurn.id, 'turn')
  assert.deepEqual(result.activeTurn.items, [])
  assert.equal(JSON.stringify(result).includes('large'), false)
})

test('invalid and cyclic cursors fail without unbounded reads; unsupported APIs use summaries only', async () => {
  await assert.rejects(
    recentHistory(async () => assert.fail('must reject before RPC'), 'thread', 'invalid'),
    /历史位置/
  )
  let calls = 0
  await assert.rejects(
    recentHistory(async (method) => {
      if (method === 'thread/turns/list') return { data: [] }
      calls++
      return { data: [], nextCursor: 'same' }
    }, 'thread'),
    /重复/
  )
  assert.equal(calls, 2)
  const result = await recentHistory(async (method, params) => {
    if (method === 'thread/items/list') throw new Error('Method not found')
    assert.equal(params.itemsView, 'summary')
    return {
      data: [
        {
          id: 'turn',
          status: 'completed',
          items: [{ id: 'a', type: 'agentMessage', text: 'safe summary' }]
        }
      ]
    }
  }, 'thread')
  assert.match(result.historyNotice, /摘要/)
  assert.equal(result.nextCursor, null)
})

test('live detail cache returns bounded tail snapshots with revisions and falls back to persisted output after completion', async () => {
  const cache = new LiveItemCache()
  cache.remember('item/started', {
    turnId: 'turn',
    item: { id: 'cmd', type: 'commandExecution', status: 'inProgress' }
  })
  const event = cache.remember('item/commandExecution/outputDelta', {
    turnId: 'turn',
    itemId: 'cmd',
    delta: 'x'.repeat(80000) + 'tail'
  })!
  const live = await cache.read(
    async () => assert.fail('running output should use cache'),
    'thread',
    'turn',
    'cmd'
  )
  assert.equal(live.revision, event.revision)
  assert.equal(live.item.aggregatedOutput.length, TOOL_OUTPUT_LIMIT)
  assert.ok(live.item.aggregatedOutput.endsWith('tail'))
  assert.ok(live.item.webPartial)
  cache.remember('item/completed', {
    turnId: 'turn',
    item: {
      id: 'cmd',
      type: 'commandExecution',
      aggregatedOutput: 'completed',
      status: 'completed'
    }
  })
  const saved = await cache.read(
    async () => ({
      data: [
        { turnId: 'turn', item: { id: 'cmd', type: 'commandExecution', aggregatedOutput: 'saved' } }
      ]
    }),
    'thread',
    'turn',
    'cmd'
  )
  assert.equal(saved.item.aggregatedOutput, 'saved')
  const fallback = await cache.read(
    async () => {
      throw new Error('not persisted yet')
    },
    'thread',
    'turn',
    'cmd'
  )
  assert.equal(fallback.item.aggregatedOutput, 'completed')
  for (let i = 0; i < 33; i++)
    cache.remember('item/started', {
      turnId: 'turn',
      item: { id: `item${i}`, type: 'commandExecution' }
    })
  await assert.rejects(
    cache.read(async () => ({ data: [] }), 'thread', 'turn', 'cmd'),
    /尚未保存/
  )
})

test('previews keep thinking visible without sending raw reasoning and full details have a size bound', () => {
  const preview = previewItem(
    { id: 'r', type: 'reasoning', summary: [], content: ['private details'] },
    'turn'
  )
  assert.ok(visibleNarrative(preview))
  assert.equal(JSON.stringify(preview).includes('private details'), false)
  assert.ok(
    boundedDetail(
      { id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'x'.repeat(1000000) }] },
      'turn'
    ).webTruncated
  )
  assert.ok(
    JSON.stringify(
      boundedDetail({ id: 'future', type: 'futureTool', input: 'x'.repeat(1000000) }, 'turn')
    ).length <
      TOOL_OUTPUT_LIMIT + 1000
  )
})
