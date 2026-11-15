import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  emptyConversation,
  mergeTurns,
  reduceEvent,
  trimWindow,
  statusLabel
} from '../../../renderer/src/custom/codex-web/state'
import {
  groupConversationItems,
  groupToolItems
} from '../../../renderer/src/custom/codex-web/tool-groups'
import { parseCodexWebCommand } from '../../../shared/codex-web-commands'
import { contextUsage } from '../../../renderer/src/custom/codex-web/status-line'

test('tool groups keep messages separate and remain stable while streaming more calls', () => {
  const initial = [
    { id: 'u', type: 'userMessage' },
    { id: 't1', type: 'commandExecution' },
    { id: 't2', type: 'fileChange' }
  ]
  const first = groupToolItems(initial)
  const next = groupToolItems([
    ...initial,
    { id: 't3', type: 'mcpToolCall' },
    { id: 'a', type: 'agentMessage', text: '进展保持可见', phase: 'commentary' },
    { id: 't4', type: 'commandExecution' }
  ])
  assert.equal(next[1].id, first[1].id)
  assert.deepEqual(
    next.map((group) => group.items.map((item) => item.id)),
    [['u'], ['t1', 't2', 't3'], ['a'], ['t4']]
  )
})

test('empty snapshots and turn boundaries do not split tools, while progress and thinking stay visible', () => {
  const tools = Array.from({ length: 5 }, (_, index) => ({
    id: `tool-${index}`,
    type: 'commandExecution'
  }))
  const groups = groupConversationItems([
    {
      id: 'first',
      items: [
        { id: 'progress', type: 'agentMessage', phase: 'commentary', text: '正在检查' },
        ...tools,
        { id: 'empty-reasoning', type: 'reasoning', summary: [], content: [] },
        { id: 'empty-agent', type: 'agentMessage', text: '' },
        { id: 'another-tool', type: 'mcpToolCall' }
      ]
    },
    {
      id: 'second',
      items: [
        { id: 'edit', type: 'fileChange' },
        { id: 'other-operation', type: 'futureToolType' },
        { id: 'thinking', type: 'reasoning', summary: ['检查下一步'], content: [] },
        { id: 'single-edit', type: 'fileChange' },
        { id: 'final', type: 'agentMessage', phase: 'final_answer', text: '完成' }
      ]
    }
  ])
  assert.deepEqual(
    groups.map((group) => ({ tools: group.tools, ids: group.items.map((item) => item.id) })),
    [
      { tools: false, ids: ['progress'] },
      {
        tools: true,
        ids: [...tools.map((item) => item.id), 'another-tool', 'edit', 'other-operation']
      },
      { tools: false, ids: ['thinking'] },
      { tools: true, ids: ['single-edit'] },
      { tools: false, ids: ['final'] }
    ]
  )
})

test('turn errors and interruptions remain visible and separate from collapsed operations', () => {
  const groups = groupConversationItems([
    {
      id: 'one',
      items: [{ id: 'a', type: 'commandExecution' }],
      error: { message: 'visible failure' }
    },
    { id: 'two', items: [{ id: 'b', type: 'fileChange' }], status: 'interrupted' }
  ])
  assert.equal(groups.length, 4)
  assert.equal(groups[1].error, 'visible failure')
  assert.equal(groups[3].interrupted, true)
})

test('slash parsing preserves paths and literal slash text, and rejects invalid goal budgets', () => {
  assert.deepEqual(parseCodexWebCommand('/model'), { name: 'model' })
  assert.deepEqual(parseCodexWebCommand('/reasoning'), { name: 'reasoning' })
  assert.equal(parseCodexWebCommand('/home/project'), null)
  assert.equal(parseCodexWebCommand('//goal plain text'), null)
  assert.deepEqual(parseCodexWebCommand('/goal budget off'), {
    name: 'goal',
    operation: 'set',
    tokenBudget: null
  })
  assert.throws(() => parseCodexWebCommand('/goal budget -1'), /正整数/)
  assert.throws(() => parseCodexWebCommand('/goal pause extra'), /用法/)
  assert.throws(() => parseCodexWebCommand('/unknown'), /暂不支持/)
  assert.equal(
    contextUsage({
      total: { totalTokens: 90000 },
      last: { totalTokens: 2000 },
      modelContextWindow: 10000
    }),
    '20% · 2,000 / 10,000'
  )
  assert.equal(contextUsage({ total: { totalTokens: 0 } }), undefined)
})

test('native settings notifications update the model and preserve an explicitly cleared effort', () => {
  const before = {
    ...emptyConversation(),
    thread: { id: 'thread', model: 'old', reasoningEffort: 'high' }
  }
  const after = reduceEvent(before, 'thread/settings/updated', {
    threadId: 'thread',
    threadSettings: { model: 'new', effort: null, modelProvider: 'custom' }
  })
  assert.equal(after.thread?.model, 'new')
  assert.equal(after.thread?.reasoningEffort, null)
  assert.equal(after.thread?.modelProvider, 'custom')
  assert.equal(before.thread.model, 'old')
})

test('streamed items are reconciled with completion snapshots without losing output', () => {
  let state = emptyConversation()
  state = reduceEvent(state, 'turn/started', { turn: { id: 't', status: 'inProgress', items: [] } })
  state = reduceEvent(state, 'item/started', {
    turnId: 't',
    item: { id: 'i', type: 'agentMessage', text: '' }
  })
  state = reduceEvent(state, 'item/agentMessage/delta', {
    turnId: 't',
    itemId: 'i',
    delta: 'Hello'
  })
  state = reduceEvent(state, 'item/agentMessage/delta', {
    turnId: 't',
    itemId: 'i',
    delta: ' world'
  })
  assert.equal(state.turns[0].items[0].text, 'Hello world')
  state = reduceEvent(state, 'turn/completed', {
    turn: { id: 't', status: 'completed', items: [] }
  })
  assert.equal(state.turns[0].items[0].text, 'Hello world')
  assert.equal(state.turns[0].status, 'completed')
})

test('older pages merge overlapping turns once and preserve newly streamed items', () => {
  const merged = mergeTurns(
    [
      { id: 'old', items: [] },
      { id: 'live', items: [{ id: 'a', text: 'saved' }] }
    ],
    [
      {
        id: 'live',
        status: 'inProgress',
        items: [
          { id: 'a', text: 'latest' },
          { id: 'b', text: 'new' }
        ]
      }
    ]
  )
  assert.equal(merged.length, 2)
  assert.deepEqual(
    merged[1].items.map((i: { text: string }) => i.text),
    ['latest', 'new']
  )
  assert.equal(statusLabel({ type: 'active', activeFlags: ['waitingOnApproval'] }).text, '等待审批')
})

test('live and browsing windows never exceed twenty narratives and share unchanged item references', () => {
  const items = Array.from({ length: 100 }, (_, index) => ({
    id: `p${index}`,
    type: 'agentMessage',
    text: `progress${index}`,
    phase: 'commentary'
  }))
  const anchor = {
    id: 'question',
    type: 'userMessage',
    content: [{ type: 'text', text: 'question' }],
    webPinned: true
  }
  const before = trimWindow({
    ...emptyConversation(),
    turns: [
      { id: 'old', status: 'completed', items: [anchor, ...items] },
      { id: 'active', status: 'inProgress', items: [] }
    ]
  })
  assert.equal(before.turns[0].items.length, 20)
  assert.equal(before.turns[0].items[0], items[80])
  assert.equal(before.turns[1].id, 'active')
  assert.ok(before.windowTrimmed)
  const after = reduceEvent(before, 'item/agentMessage/delta', {
    turnId: 'active',
    itemId: 'new',
    delta: 'stream'
  })
  assert.equal(after.turns[0].items[0], items[81])
  assert.equal(after.turns[0].items[1], items[82])
  assert.equal(before.turns[1].items.length, 0)
  const browsing = trimWindow({
    ...emptyConversation(),
    browsingHistory: true,
    turns: [{ id: 'history', items }]
  })
  assert.equal(browsing.turns[0].items.length, 20)
  assert.equal(browsing.turns[0].items[0], items[0])
})
