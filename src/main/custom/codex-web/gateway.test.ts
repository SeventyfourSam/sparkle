import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer as createTcpServer } from 'node:net'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import { CodexGateway } from './gateway'
import type { CodexRecord } from '../../../shared/codex-web'

function inbox(socket: WebSocket): {
  messages: CodexRecord[]
  wait: (predicate: (message: CodexRecord) => boolean) => Promise<CodexRecord>
} {
  const messages: CodexRecord[] = []
  const waiters = new Set<() => void>()
  socket.on('message', (bytes) => {
    messages.push(JSON.parse(bytes.toString()))
    for (const notify of waiters) notify()
  })
  return {
    messages,
    wait: (predicate) =>
      new Promise((resolve, reject) => {
        const check = (): void => {
          const index = messages.findIndex(predicate)
          if (index >= 0) {
            clearTimeout(timer)
            waiters.delete(check)
            resolve(messages.splice(index, 1)[0])
          }
        }
        const timer = setTimeout(() => {
          waiters.delete(check)
          reject(new Error('Timed out waiting for protocol message'))
        }, 4000)
        waiters.add(check)
        check()
      })
  }
}

async function fixture(
  options: {
    failResume?: boolean
    failHistoryOnce?: boolean
    offlineRetentionMs?: number
    separatePorts?: boolean
    emptyInitial?: boolean
    deferGoalGet?: boolean
    unsupportedGoals?: boolean
    unsupportedSettings?: boolean
    rejectSettings?: boolean
  } = {}
): Promise<{
  gateway: CodexGateway
  directory: string
  port: number
  webPort: number
  backend: WebSocket
  rpc: ReturnType<typeof inbox>
  browser: WebSocket
  web: ReturnType<typeof inbox>
  action: (action: string, params?: CodexRecord) => Promise<CodexRecord>
  close: () => Promise<void>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'sparkle-codex-gateway-'))
  await writeFile(join(directory, 'codex.html'), '<html>Codex mobile</html>')
  const gateway = new CodexGateway({
    port: 0,
    host: options.separatePorts ? undefined : '127.0.0.1',
    webPort: options.separatePorts ? 0 : undefined,
    frontendDir: directory,
    version: 'test',
    offlineRetentionMs: options.offlineRetentionMs
  })
  const port = await gateway.start()
  const webPort = gateway.ports().webPort
  const backend = new WebSocket(`ws://127.0.0.1:${port}/codex/app-server`, {
    headers: {
      'x-codex-pid': '12345',
      'x-codex-instance-id': 'instance-a',
      'x-codex-runtime': 'embedded'
    }
  })
  const rpc = inbox(backend)
  const thread = {
    id: 'thread-a',
    name: 'A live task',
    cwd: 'D:/work',
    model: 'fixture-model',
    modelProvider: 'fixture-provider',
    reasoningEffort: 'high',
    status: { type: 'active', activeFlags: [] },
    turns: []
  }
  const created = new Map<string, CodexRecord>()
  const persisted = new Set<string>()
  let goal: CodexRecord | null = null
  backend.on('message', (bytes) => {
    const message = JSON.parse(bytes.toString())
    if (!message.method || message.id === undefined) return
    if (
      message.method === 'thread/settings/update' &&
      (options.unsupportedSettings || options.rejectSettings)
    ) {
      backend.send(
        JSON.stringify({
          id: message.id,
          error: {
            code: options.unsupportedSettings ? -32601 : -32600,
            message: options.unsupportedSettings ? 'Method not found' : 'model selection refused'
          }
        })
      )
      return
    }
    if (options.deferGoalGet && message.method === 'thread/goal/get') return
    if (options.unsupportedGoals && message.method.startsWith('thread/goal/')) {
      backend.send(
        JSON.stringify({ id: message.id, error: { code: -32601, message: 'Method not found' } })
      )
      return
    }
    if (
      (options.failResume && message.method === 'thread/resume') ||
      (options.failHistoryOnce && message.method === 'thread/turns/list')
    ) {
      options.failHistoryOnce = false
      backend.send(
        JSON.stringify({
          id: message.id,
          error: {
            code: -32600,
            message: options.failResume ? 'no rollout found' : 'history temporarily unavailable'
          }
        })
      )
      return
    }
    let result: CodexRecord = {}
    if (message.method === 'model/list')
      result = message.params.cursor
        ? {
            data: [
              {
                id: 'display-fast',
                model: 'fixture-fast',
                displayName: 'Fast fixture',
                defaultReasoningEffort: 'low',
                supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }]
              },
              {
                id: 'display-no-reasoning',
                model: 'fixture-no-reasoning',
                displayName: 'No reasoning',
                defaultReasoningEffort: '',
                supportedReasoningEfforts: []
              }
            ],
            nextCursor: null
          }
        : {
            data: [
              {
                id: 'display-main',
                model: 'fixture-model',
                displayName: 'Main fixture',
                defaultReasoningEffort: 'high',
                supportedReasoningEfforts: ['low', 'high', 'ultra'].map((reasoningEffort) => ({
                  reasoningEffort,
                  description: reasoningEffort
                }))
              }
            ],
            nextCursor: 'models-page-2'
          }
    if (message.method === 'thread/settings/update') {
      const current = created.get(message.params.threadId) || thread
      current.model = message.params.model
      if (message.params.effort !== undefined) current.reasoningEffort = message.params.effort
      else if (current.model === 'fixture-no-reasoning') current.reasoningEffort = null
      backend.send(
        JSON.stringify({
          method: 'thread/settings/updated',
          params: {
            threadId: message.params.threadId,
            threadSettings: {
              model: current.model,
              effort: current.reasoningEffort,
              modelProvider: 'fixture-provider',
              cwd: current.cwd
            }
          }
        })
      )
    }
    if (message.method === 'thread/goal/get') result = { goal }
    if (message.method === 'thread/goal/set') {
      const { threadId, objective, status, tokenBudget } = message.params
      goal = {
        ...(goal || { threadId, objective: '', status: 'active' }),
        ...(objective !== undefined ? { objective } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(tokenBudget !== undefined ? { tokenBudget } : {})
      }
      result = { goal }
    }
    if (message.method === 'thread/goal/clear') {
      goal = null
      result = { cleared: true }
    }
    if (message.method === 'thread/loaded/list')
      result = {
        data: [...(options.emptyInitial ? [] : ['thread-a']), ...created.keys()],
        nextCursor: null
      }
    if (message.method === 'thread/start') {
      const id = `created-${created.size + 1}`
      const value = {
        id,
        name: null,
        preview: '',
        cwd: message.params.cwd || tmpdir(),
        status: { type: 'idle' },
        updatedAt: 0
      }
      created.set(id, value)
      result = { thread: value, model: 'fixture-model' }
    }
    if (message.method === 'thread/read' || message.method === 'thread/resume') {
      const id = message.params.threadId
      if (created.has(id) && !persisted.has(id)) {
        backend.send(
          JSON.stringify({ id: message.id, error: { code: -32600, message: 'no rollout found' } })
        )
        return
      }
      result = { thread: created.get(id) || thread }
    }
    if (message.method === 'turn/start') {
      persisted.add(message.params.threadId)
      result = { turn: { id: 'turn-created', status: 'inProgress', items: [] } }
    }
    if (message.method === 'thread/turns/list')
      result = {
        data: [
          {
            id: 'turn-a',
            status: 'inProgress',
            items: [{ id: 'item-a', type: 'agentMessage', text: 'Hello' }]
          }
        ],
        nextCursor: null
      }
    if (message.method === 'thread/items/list')
      result = {
        data: [{ turnId: 'turn-a', item: { id: 'item-a', type: 'agentMessage', text: 'Hello' } }],
        nextCursor: null
      }
    if (message.method === 'thread/items/read')
      result = {
        data: [
          {
            turnId: message.params.turnId,
            item: {
              id: message.params.itemIds[0],
              type: 'commandExecution',
              aggregatedOutput: 'persisted output'
            }
          }
        ]
      }
    backend.send(JSON.stringify({ id: message.id, result }))
  })
  await once(backend, 'open')
  await rpc.wait((m) => m.method === 'initialized')
  const browser = new WebSocket(`ws://127.0.0.1:${webPort}/codex/browser`, {
    origin: `http://127.0.0.1:${webPort}`
  })
  const web = inbox(browser)
  await once(browser, 'open')
  await web.wait(
    (m) =>
      m.type === 'instances' &&
      m.instances[0]?.ready &&
      (options.emptyInitial || m.instances[0]?.threads.length)
  )
  let sequence = 0
  return {
    gateway,
    directory,
    port,
    webPort,
    backend,
    rpc,
    browser,
    web,
    action: async (action, params = {}) => {
      const id = `test-${++sequence}`
      browser.send(
        JSON.stringify({ id, action, instanceId: 'instance-a', threadId: 'thread-a', ...params })
      )
      return web.wait((m) => m.type === 'result' && m.id === id)
    },
    close: async () => {
      await gateway.stop()
      await rm(directory, { recursive: true, force: true })
    }
  }
}

test('reverse handshake initializes the native client and serves only the mobile entry', async () => {
  const f = await fixture()
  try {
    const initialize = await f.rpc.wait((m) => m.method === 'initialize')
    assert.equal(initialize.params.clientInfo.name, 'codex-backend')
    assert.deepEqual(initialize.params.capabilities, {
      experimentalApi: true,
      requiredHumanApproval: true
    })
    assert.match(await (await fetch(`http://127.0.0.1:${f.port}/`)).text(), /Codex mobile/)
    assert.equal((await fetch(`http://127.0.0.1:${f.port}/index.html`)).status, 404)
    assert.equal((await fetch(`http://127.0.0.1:${f.port}/assets/..%2f..%2fsecret`)).status, 404)
  } finally {
    await f.close()
  }
})

test('watch sends history once and streams heavy output only while that detail is open', async () => {
  const f = await fixture()
  try {
    const ack = await f.action('watch')
    assert.deepEqual(ack.result, {})
    const history = await f.web.wait((m) => m.type === 'history')
    assert.equal(history.turns[0].items[0].text, 'Hello')
    assert.equal(
      (await f.rpc.wait((m) => m.method === 'thread/turns/list')).params.itemsView,
      'summary'
    )
    f.backend.send(
      JSON.stringify({
        method: 'item/started',
        params: {
          threadId: 'thread-a',
          turnId: 'turn-a',
          item: {
            id: 'cmd',
            type: 'commandExecution',
            aggregatedOutput: 'hidden payload',
            status: 'inProgress'
          }
        }
      })
    )
    const start = await f.web.wait((m) => m.method === 'item/started')
    assert.equal(start.params.item.aggregatedOutput, undefined)
    assert.equal(start.params.item.webDeferred, true)
    f.backend.send(
      JSON.stringify({
        method: 'item/commandExecution/outputDelta',
        params: { threadId: 'thread-a', turnId: 'turn-a', itemId: 'cmd', delta: ' first' }
      })
    )
    const detail = await f.action('item', { turnId: 'turn-a', itemId: 'cmd' })
    assert.equal(detail.result.item.aggregatedOutput, 'hidden payload first')
    assert.equal(
      f.web.messages.some((m) => m.method === 'item/commandExecution/outputDelta'),
      false
    )
    f.backend.send(
      JSON.stringify({
        method: 'item/commandExecution/outputDelta',
        params: { threadId: 'thread-a', turnId: 'turn-a', itemId: 'cmd', delta: ' live' }
      })
    )
    const live = await f.web.wait((m) => m.type === 'detail')
    assert.equal(live.delta, ' live')
    assert.ok(live.revision > detail.result.revision)
    await f.action('item/unwatch', { turnId: 'turn-a', itemId: 'cmd' })
    f.backend.send(
      JSON.stringify({
        method: 'item/commandExecution/outputDelta',
        params: { threadId: 'thread-a', turnId: 'turn-a', itemId: 'cmd', delta: ' closed' }
      })
    )
    // The following lightweight lifecycle event is an ordering barrier on the same socket.
    f.backend.send(
      JSON.stringify({
        method: 'turn/completed',
        params: {
          threadId: 'thread-a',
          turn: {
            id: 'turn-a',
            status: 'completed',
            items: [{ id: 'huge', text: 'x'.repeat(10000) }]
          }
        }
      })
    )
    const completed = await f.web.wait((m) => m.method === 'turn/completed')
    assert.deepEqual(completed.params.turn.items, [])
    assert.equal(
      f.web.messages.some((m) => m.type === 'detail'),
      false
    )
    assert.match((await f.action('item', { turnId: '', itemId: 'cmd' })).error, /无效/)
  } finally {
    await f.close()
  }
})

test('new sessions use thread/start, keep an empty thread available, then send the first turn', async () => {
  const f = await fixture({ separatePorts: true })
  try {
    const cwd = f.directory
    const created = await f.action('create', { cwd })
    assert.equal(created.error, undefined)
    assert.equal(created.result.thread.id, 'created-1')
    assert.equal(created.result.thread.cwd, cwd)
    assert.deepEqual((await f.rpc.wait((m) => m.method === 'thread/start')).params, { cwd })

    await f.action('refresh')
    assert.ok(f.gateway.snapshot()[0].threads.some((item) => item.id === 'created-1'))
    assert.equal((await f.action('watch', { threadId: 'created-1' })).error, undefined)
    const history = await f.web.wait((m) => m.type === 'history' && m.threadId === 'created-1')
    assert.deepEqual(history.turns, [])
    await f.action('unwatch')
    assert.equal(
      f.rpc.messages.some(
        (m) => m.method === 'thread/unsubscribe' && m.params.threadId === 'created-1'
      ),
      false
    )
    assert.equal((await f.action('watch', { threadId: 'created-1' })).error, undefined)
    assert.equal(
      f.rpc.messages.some((m) => m.method === 'thread/resume' && m.params.threadId === 'created-1'),
      false
    )
    assert.equal(
      (await f.action('send', { threadId: 'created-1', text: '开始工作' })).error,
      undefined
    )
    assert.deepEqual((await f.rpc.wait((m) => m.method === 'turn/start')).params, {
      threadId: 'created-1',
      input: [{ type: 'text', text: '开始工作' }]
    })
    await f.action('unwatch')
    assert.equal(
      (
        await f.rpc.wait(
          (m) => m.method === 'thread/unsubscribe' && m.params.threadId === 'created-1'
        )
      ).params.threadId,
      'created-1'
    )
  } finally {
    await f.close()
  }
})

test('directory browsing lists folders and rejects invalid paths without a Codex instance', async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.directory, '中文 项目'))
    await mkdir(join(f.directory, 'project-2'))
    await symlink(
      join(f.directory, '中文 项目'),
      join(f.directory, 'linked-project'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const result = await f.action('directories', { instanceId: 'not-connected', path: f.directory })
    assert.equal(result.error, undefined)
    assert.equal(result.result.path, f.directory)
    assert.ok(result.result.parent)
    assert.deepEqual(
      result.result.entries.map((entry: CodexRecord) => entry.name).sort(),
      ['linked-project', 'project-2', '中文 项目'].sort()
    )
    const linked = await f.action('directories', { path: join(f.directory, 'linked-project') })
    assert.equal(linked.result.path, join(f.directory, 'linked-project'))
    assert.match((await f.action('directories', { path: 'relative/project' })).error, /绝对路径/)
    assert.match(
      (await f.action('directories', { path: join(f.directory, 'codex.html') })).error,
      /目录不存在或无法访问/
    )
  } finally {
    await f.close()
  }
})

test('new sessions require an existing absolute directory before sending any request to Codex', async () => {
  const f = await fixture({ emptyInitial: true })
  try {
    assert.equal(f.gateway.snapshot()[0].threads.length, 0)
    assert.match((await f.action('create', { cwd: 'relative/project' })).error, /绝对路径/)
    assert.match((await f.action('create', { cwd: '' })).error, /绝对路径/)
    assert.match(
      (await f.action('create', { cwd: join(f.directory, 'missing') })).error,
      /目录不存在或无法访问/
    )
    assert.match(
      (await f.action('create', { cwd: join(f.directory, 'codex.html') })).error,
      /目录不存在或无法访问/
    )
    assert.equal(
      f.rpc.messages.some((m) => m.method === 'thread/start'),
      false
    )
    const created = await f.action('create', { cwd: f.directory })
    assert.equal(created.result.thread.id, 'created-1')
    assert.deepEqual((await f.rpc.wait((m) => m.method === 'thread/start')).params, {
      cwd: f.directory
    })
  } finally {
    await f.close()
  }
})

test('model selection uses the active provider catalogue and updates native settings without starting a turn', async () => {
  const f = await fixture()
  try {
    assert.match((await f.action('models')).error, /先打开/)
    await f.action('watch')
    const catalog = await f.action('models')
    assert.deepEqual(
      catalog.result.models.map((model: CodexRecord) => model.model),
      ['fixture-model', 'fixture-fast', 'fixture-no-reasoning']
    )
    assert.equal(catalog.result.models[0].supportedReasoningEfforts.at(-1).reasoningEffort, 'ultra')
    const pages = f.rpc.messages.filter((message) => message.method === 'model/list')
    assert.equal(pages.length, 2)
    assert.ok(pages.every((message) => message.params.modelProvider === 'fixture-provider'))
    assert.equal(
      (
        await f.action('settings', {
          model: 'fixture-fast',
          effort: 'low',
          expectedModel: 'fixture-model',
          expectedEffort: 'high'
        })
      ).error,
      undefined
    )
    assert.deepEqual(
      (await f.rpc.wait((message) => message.method === 'thread/settings/update')).params,
      { threadId: 'thread-a', model: 'fixture-fast', effort: 'low' }
    )
    assert.equal(f.gateway.snapshot()[0].threads[0].model, 'fixture-fast')
    assert.equal(f.gateway.snapshot()[0].threads[0].reasoningEffort, 'low')
    await f.web.wait((message) => message.type === 'history')
    await f.action('unwatch')
    await f.action('watch')
    const history = await f.web.wait((message) => message.type === 'history')
    assert.equal(history.thread.model, 'fixture-fast')
    assert.equal(history.thread.reasoningEffort, 'low')
    assert.equal(
      f.rpc.messages.some((message) =>
        [
          'turn/start',
          'turn/steer',
          'turn/interrupt',
          'config/read',
          'config/value/write'
        ].includes(message.method)
      ),
      false
    )
  } finally {
    await f.close()
  }
})

test('unsupported models, effort levels and stale client settings are rejected before mutation', async () => {
  const f = await fixture()
  try {
    await f.action('watch')
    assert.match((await f.action('settings', { model: 'not-in-catalog' })).error, /请选择/)
    assert.match(
      (await f.action('settings', { model: 'fixture-fast', effort: 'ultra' })).error,
      /不支持/
    )
    f.backend.send(
      JSON.stringify({
        method: 'thread/settings/updated',
        params: { threadId: 'thread-a', threadSettings: { model: 'fixture-model', effort: null } }
      })
    )
    await f.web.wait(
      (message) => message.type === 'event' && message.method === 'thread/settings/updated'
    )
    assert.match(
      (
        await f.action('settings', {
          model: 'fixture-fast',
          effort: 'low',
          expectedModel: 'fixture-model',
          expectedEffort: 'high'
        })
      ).error,
      /其他客户端/
    )
    assert.equal(
      f.rpc.messages.some((message) => message.method === 'thread/settings/update'),
      false
    )
  } finally {
    await f.close()
  }
})

test('failed or unavailable native settings updates do not change the displayed model', async () => {
  for (const options of [{ rejectSettings: true }, { unsupportedSettings: true }]) {
    const f = await fixture(options)
    try {
      await f.action('watch')
      const response = await f.action('settings', { model: 'fixture-fast', effort: 'low' })
      assert.match(response.error, options.unsupportedSettings ? /版本不支持/ : /refused/)
      assert.equal(f.gateway.snapshot()[0].threads[0].model, 'fixture-model')
    } finally {
      await f.close()
    }
  }
})

test('slash commands call native goal, compaction and interrupt methods without prompting the model', async () => {
  const f = await fixture()
  try {
    await f.action('watch')
    const goal = await f.action('send', { text: '/goal 完成网页适配' })
    assert.equal(goal.result.webCommand.goal.objective, '完成网页适配')
    assert.deepEqual((await f.rpc.wait((m) => m.method === 'thread/goal/set')).params, {
      threadId: 'thread-a',
      origin: 'user',
      objective: '完成网页适配',
      status: 'active'
    })
    await f.action('send', { text: '/goal pause' })
    assert.equal((await f.rpc.wait((m) => m.method === 'thread/goal/set')).params.status, 'paused')
    await f.action('send', { text: '/goal budget 12000' })
    assert.equal(
      (await f.rpc.wait((m) => m.method === 'thread/goal/set')).params.tokenBudget,
      12000
    )
    await f.action('send', { text: '/goal clear' })
    assert.equal((await f.rpc.wait((m) => m.method === 'thread/goal/clear')).params.origin, 'user')
    await f.action('send', { text: '/compact' })
    assert.equal(
      (await f.rpc.wait((m) => m.method === 'thread/compact/start')).params.threadId,
      'thread-a'
    )
    await f.action('send', { text: '/stop', turnId: 'turn-a' })
    assert.deepEqual((await f.rpc.wait((m) => m.method === 'turn/interrupt')).params, {
      threadId: 'thread-a',
      turnId: 'turn-a'
    })
    assert.match((await f.action('send', { text: '/side 旁支问题' })).error, /暂不支持/)
    assert.match((await f.action('send', { text: '/not-a-command' })).error, /暂不支持/)
    assert.equal(
      f.rpc.messages.some((m) => m.method === 'turn/start' || m.method === 'turn/steer'),
      false
    )
    await f.action('send', { text: '//goal literal text' })
    assert.equal(
      (await f.rpc.wait((m) => m.method === 'turn/start')).params.input[0].text,
      '/goal literal text'
    )
  } finally {
    await f.close()
  }
})

test('a delayed goal read cannot replace a newer native goal update', async () => {
  const f = await fixture({ deferGoalGet: true })
  try {
    await f.action('watch')
    const read = await f.rpc.wait((m) => m.method === 'thread/goal/get')
    const goal = { threadId: 'thread-a', objective: 'new goal', status: 'active' }
    f.backend.send(
      JSON.stringify({ method: 'thread/goal/updated', params: { threadId: 'thread-a', goal } })
    )
    await f.web.wait((m) => m.type === 'event' && m.method === 'thread/goal/updated')
    f.backend.send(JSON.stringify({ id: read.id, result: { goal: null } }))
    await f.action('unwatch')
    await f.web.wait((m) => m.type === 'history')
    await f.action('watch')
    assert.deepEqual((await f.web.wait((m) => m.type === 'history')).goal, goal)
  } finally {
    await f.close()
  }
})

test('servers without goal support still load history and accept regular messages', async () => {
  const f = await fixture({ unsupportedGoals: true })
  try {
    assert.equal((await f.action('watch')).error, undefined)
    assert.match((await f.action('send', { text: '/goal' })).error, /Method not found/)
    assert.equal((await f.action('send', { text: 'ordinary message' })).error, undefined)
  } finally {
    await f.close()
  }
})

test('runtime status is restored when a browser reopens the same thread', async () => {
  const f = await fixture()
  try {
    await f.action('watch')
    await f.web.wait((m) => m.type === 'history')
    const tokenUsage = {
      total: { totalTokens: 1234 },
      last: { totalTokens: 500 },
      modelContextWindow: 10000
    }
    f.backend.send(
      JSON.stringify({
        method: 'thread/tokenUsage/updated',
        params: { threadId: 'thread-a', tokenUsage }
      })
    )
    await f.web.wait((m) => m.type === 'event' && m.method === 'thread/tokenUsage/updated')
    await f.action('unwatch')
    await f.action('watch')
    assert.deepEqual((await f.web.wait((m) => m.type === 'history')).tokenUsage, tokenUsage)
  } finally {
    await f.close()
  }
})

test('history, streamed messages, steering and interruption reach the original instance', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.action('watch')).error, undefined)
    const history = await f.web.wait((m) => m.type === 'history')
    assert.equal(history.turns[0].items[0].text, 'Hello')
    f.backend.send(
      JSON.stringify({
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-a', turnId: 'turn-a', itemId: 'item-a', delta: ' world' }
      })
    )
    assert.equal(
      (await f.web.wait((m) => m.type === 'event' && m.method === 'item/agentMessage/delta')).params
        .delta,
      ' world'
    )
    assert.equal((await f.action('send', { text: 'Continue', turnId: 'turn-a' })).error, undefined)
    assert.deepEqual((await f.rpc.wait((m) => m.method === 'turn/steer')).params, {
      threadId: 'thread-a',
      expectedTurnId: 'turn-a',
      input: [{ type: 'text', text: 'Continue' }]
    })
    await f.action('interrupt', { turnId: 'turn-a' })
    assert.equal((await f.rpc.wait((m) => m.method === 'turn/interrupt')).params.turnId, 'turn-a')
    const unavailable = await f.action('watch', { threadId: 'another-process-thread' })
    assert.match(unavailable.error, /不在该 app-server/)
  } finally {
    await f.close()
  }
})

test('approvals preserve request ID types and terminal resolutions prevent duplicate responses', async () => {
  const f = await fixture()
  try {
    await f.action('watch')
    f.backend.send(
      JSON.stringify({
        id: 77,
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'thread-a', turnId: 'turn-a', command: 'echo test' }
      })
    )
    const request = (await f.web.wait((m) => m.type === 'requests' && m.requests.length))
      .requests[0]
    await f.action('respond', { key: request.key, decision: 'accept' })
    assert.deepEqual(await f.rpc.wait((m) => m.id === 77 && !m.method), {
      id: 77,
      result: { decision: 'accept' }
    })
    assert.match(
      (await f.action('respond', { key: request.key, decision: 'decline' })).error,
      /已处理/
    )
    f.backend.send(
      JSON.stringify({
        method: 'serverRequest/resolved',
        params: { threadId: 'thread-a', requestId: 77 }
      })
    )
    await f.web.wait((m) => m.type === 'requests' && m.requests.length === 0)
    assert.match(
      (await f.action('respond', { key: request.key, decision: 'accept' })).error,
      /已处理/
    )
  } finally {
    await f.close()
  }
})

test('answers and permission grants use the native response schemas', async () => {
  const f = await fixture()
  try {
    f.backend.send(
      JSON.stringify({
        id: 'question',
        method: 'item/tool/requestUserInput',
        params: { threadId: 'thread-a', questions: [{ id: 'choice', question: 'Which?' }] }
      })
    )
    await f.web.wait(
      (m) => m.type === 'requests' && m.requests.some((r: CodexRecord) => r.id === 'question')
    )
    await f.action('respond', { key: 'string:question', answers: { choice: 'Option A' } })
    assert.deepEqual((await f.rpc.wait((m) => m.id === 'question' && !m.method)).result, {
      answers: { choice: { answers: ['Option A'] } }
    })
    f.backend.send(
      JSON.stringify({
        id: 'permission',
        method: 'item/permissions/requestApproval',
        params: { threadId: 'thread-a', permissions: { network: { enabled: true } } }
      })
    )
    await f.web.wait(
      (m) => m.type === 'requests' && m.requests.some((r: CodexRecord) => r.id === 'permission')
    )
    await f.action('respond', { key: 'string:permission', decision: 'decline' })
    assert.deepEqual((await f.rpc.wait((m) => m.id === 'permission' && !m.method)).result, {
      permissions: {},
      scope: 'turn'
    })
    f.backend.send(
      JSON.stringify({
        id: 'grant',
        method: 'item/permissions/requestApproval',
        params: {
          threadId: 'thread-a',
          permissions: { network: { enabled: true }, fileSystem: null }
        }
      })
    )
    await f.web.wait(
      (m) => m.type === 'requests' && m.requests.some((r: CodexRecord) => r.id === 'grant')
    )
    await f.action('respond', { key: 'string:grant', decision: 'accept' })
    assert.deepEqual((await f.rpc.wait((m) => m.id === 'grant' && !m.method)).result, {
      permissions: { network: { enabled: true } },
      scope: 'turn'
    })
  } finally {
    await f.close()
  }
})

test('multiple browsers share subscriptions; closing one does not detach the other', async () => {
  const f = await fixture()
  const second = new WebSocket(`ws://127.0.0.1:${f.port}/codex/browser`, {
    origin: `http://127.0.0.1:${f.port}`
  })
  const secondInbox = inbox(second)
  try {
    await once(second, 'open')
    await f.action('watch')
    second.send(
      JSON.stringify({
        id: 'watch-second',
        action: 'watch',
        instanceId: 'instance-a',
        threadId: 'thread-a'
      })
    )
    await secondInbox.wait((m) => m.id === 'watch-second')
    assert.equal(f.rpc.messages.filter((m) => m.method === 'thread/resume').length, 1)
    await f.action('unwatch')
    assert.equal(
      f.rpc.messages.some((m) => m.method === 'thread/unsubscribe'),
      false
    )
    second.close()
    await f.rpc.wait((m) => m.method === 'thread/unsubscribe')
  } finally {
    second.terminate()
    await f.close()
  }
})

test('same instance reconnect replaces the old socket and browser is resubscribed', async () => {
  const f = await fixture()
  try {
    await f.action('watch')
    const replacement = new WebSocket(`ws://127.0.0.1:${f.port}/codex/app-server`, {
      headers: {
        'x-codex-pid': '12345',
        'x-codex-instance-id': 'instance-a',
        'x-codex-runtime': 'embedded'
      }
    })
    const replacementInbox = inbox(replacement)
    replacement.on('message', (bytes) => {
      const m = JSON.parse(bytes.toString())
      if (!m.method || m.id === undefined) return
      const result =
        m.method === 'thread/loaded/list'
          ? { data: ['thread-a'] }
          : m.method === 'thread/turns/list'
            ? { data: [], nextCursor: null }
            : { thread: { id: 'thread-a' } }
      replacement.send(JSON.stringify({ id: m.id, result }))
    })
    await replacementInbox.wait((m) => m.method === 'thread/resume')
    assert.equal(f.gateway.snapshot().length, 1)
    assert.equal(f.gateway.snapshot()[0].connected, true)
    replacement.terminate()
  } finally {
    await f.close()
  }
})

test('browser requests require the page origin and backend requires instance headers', async () => {
  const f = await fixture()
  try {
    for (const [path, options] of [
      ['/codex/browser', { origin: 'http://another-site.invalid' }],
      ['/codex/app-server', {}]
    ] as const) {
      const socket = new WebSocket(`ws://127.0.0.1:${f.port}${path}`, options)
      const [error] = await once(socket, 'error')
      assert.match(String(error), /403|400/)
    }
  } finally {
    await f.close()
  }
})

test('a browser reconnecting before app-server automatically receives history when the instance returns', async () => {
  const f = await fixture()
  try {
    f.backend.close()
    await f.web.wait((m) => m.type === 'instances' && m.instances[0]?.connected === false)
    assert.match((await f.action('watch')).error, /尚未连接/)
    const replacement = new WebSocket(`ws://127.0.0.1:${f.port}/codex/app-server`, {
      headers: {
        'x-codex-pid': '12345',
        'x-codex-instance-id': 'instance-a',
        'x-codex-runtime': 'embedded'
      }
    })
    replacement.on('message', (bytes) => {
      const m = JSON.parse(bytes.toString())
      if (!m.method || m.id === undefined) return
      const result =
        m.method === 'thread/loaded/list'
          ? { data: ['thread-a'] }
          : m.method === 'thread/turns/list'
            ? { data: [], nextCursor: null }
            : { thread: { id: 'thread-a' } }
      replacement.send(JSON.stringify({ id: m.id, result }))
    })
    await f.web.wait((m) => m.type === 'history' && m.threadId === 'thread-a')
    replacement.terminate()
  } finally {
    await f.close()
  }
})

test('failed subscription cannot send and malformed browser payloads do not break the service', async () => {
  const f = await fixture({ failResume: true })
  try {
    assert.match((await f.action('watch')).error, /no rollout found/)
    assert.match((await f.action('send', { text: 'should not send' })).error, /重新同步/)
    f.browser.send('null')
    assert.match((await f.web.wait((m) => m.type === 'error')).error, /无效消息/)
    assert.equal((await f.action('refresh')).error, undefined)
  } finally {
    await f.close()
  }
})

test('retrying a history failure reuses and eventually releases the successful subscription', async () => {
  const f = await fixture({ failHistoryOnce: true })
  try {
    assert.match((await f.action('watch')).error, /history temporarily unavailable/)
    assert.equal((await f.action('watch')).error, undefined)
    assert.equal(f.rpc.messages.filter((m) => m.method === 'thread/resume').length, 1)
    await f.action('unwatch')
    await f.rpc.wait((m) => m.method === 'thread/unsubscribe')
  } finally {
    await f.close()
  }
})

test('offline instances expire after leaving the conversation while an open view survives for reconnect', async () => {
  const f = await fixture({ offlineRetentionMs: 0 })
  try {
    await f.action('watch')
    f.backend.close()
    await f.web.wait((m) => m.type === 'instances' && m.instances[0]?.connected === false)
    await f.action('refresh')
    assert.equal(f.gateway.snapshot().length, 1)
    await f.action('unwatch')
    await f.action('refresh')
    assert.equal(f.gateway.snapshot().length, 0)
  } finally {
    await f.close()
  }
})

test('separate ports keep Codex local and expose the mobile site on all IPv4 interfaces', async () => {
  const f = await fixture({ separatePorts: true })
  try {
    assert.notEqual(f.port, f.webPort)
    assert.equal((await fetch(`http://127.0.0.2:${f.webPort}/`)).status, 200)
    assert.equal((await fetch(`http://127.0.0.1:${f.port}/`)).status, 404)
    assert.equal((await f.action('watch')).error, undefined)
    for (const [port, path, options] of [
      [
        f.webPort,
        '/codex/app-server',
        {
          headers: {
            'x-codex-pid': '123',
            'x-codex-instance-id': 'wrong-port',
            'x-codex-runtime': 'embedded'
          }
        }
      ],
      [f.port, '/codex/browser', { origin: `http://127.0.0.1:${f.port}` }]
    ] as const) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, options)
      const [error] = await once(socket, 'error')
      assert.match(String(error), /403/)
    }
  } finally {
    await f.close()
  }
})

test('an occupied web port releases the partially started Codex listener and shutdown is idempotent', async () => {
  const busy = createTcpServer()
  const probe = createTcpServer()
  await new Promise<void>((done) => {
    busy.listen(0, '0.0.0.0', done)
  })
  await new Promise<void>((done) => {
    probe.listen(0, '127.0.0.1', done)
  })
  const webPort = (busy.address() as { port: number }).port
  const port = (probe.address() as { port: number }).port
  await new Promise<void>((done) => {
    probe.close(() => done())
  })
  const gateway = new CodexGateway({ port, webPort, frontendDir: tmpdir(), version: 'test' })
  try {
    await assert.rejects(gateway.start(), /EADDRINUSE/)
    await gateway.stop()
    await new Promise<void>((done, reject) => {
      probe.once('error', reject)
      probe.listen(port, '127.0.0.1', done)
    })
  } finally {
    await gateway.stop()
    await new Promise<void>((done) => {
      probe.close(() => done())
    })
    await new Promise<void>((done) => {
      busy.close(() => done())
    })
  }
})
