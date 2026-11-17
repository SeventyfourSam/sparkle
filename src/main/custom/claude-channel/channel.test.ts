import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { WebSocket } from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CodexGateway } from '../codex-web/gateway'
import { claudeLaunchConfig } from './launch-config'
import { claudeHistory, replyId } from './history'
import {
  appendDefaultCommandProfile,
  channelAvailable,
  enableDefaultCommand,
  publishDefaultCommand,
  shouldAttachClaude
} from './default-command'
import type { TerminalStart } from './terminal'
import type { CodexRecord } from '../../../shared/codex-web'

function inbox(socket: WebSocket) {
  const messages: CodexRecord[] = [],
    waiters = new Set<() => void>()
  socket.on('message', (bytes) => {
    messages.push(JSON.parse(bytes.toString()))
    for (const notify of waiters) notify()
  })
  return {
    messages,
    wait: (predicate: (message: CodexRecord) => boolean) =>
      new Promise<CodexRecord>((resolve, reject) => {
        const check = () => {
          const i = messages.findIndex(predicate)
          if (i >= 0) {
            clearTimeout(timer)
            waiters.delete(check)
            resolve(messages.splice(i, 1)[0])
          }
        }
        const timer = setTimeout(() => {
          waiters.delete(check)
          reject(new Error('Protocol timeout'))
        }, 7000)
        waiters.add(check)
        check()
      })
  }
}

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'sparkle claude test ')))
  await writeFile(join(directory, 'codex.html'), '<html>mobile</html>')
  const starts: TerminalStart[] = [],
    keys: string[] = []
  let kills = 0
  const gateway = new CodexGateway({
    port: 0,
    webPort: 0,
    frontendDir: directory,
    version: 'test',
    claude: {
      directory: join(directory, 'private'),
      bridgeFile: resolve('src/main/custom/claude-channel/entry.ts'),
      startTerminal: async (start) => {
        starts.push(start)
        start.onData('Native trust prompt\r\n')
        return {
          pid: 123,
          write: (key) => keys.push(key),
          resize: () => {},
          kill: () => {
            kills++
            start.onExit(0)
          }
        }
      }
    }
  })
  await gateway.start()
  const { port, webPort } = gateway.ports()
  const base = `http://127.0.0.1:${webPort}`,
    origin = base
  const response = await fetch(`${base}/claude/api/access`)
  const access = (await response.json()) as CodexRecord
  const cookie = ''
  const browser = new WebSocket(`ws://127.0.0.1:${webPort}/claude/browser`, {
    headers: { Origin: origin, Cookie: cookie }
  })
  const web = inbox(browser)
  await once(browser, 'open')
  let sequence = 0
  const action = async (action: string, params: CodexRecord = {}) => {
    const id = `test:${++sequence}`
    browser.send(JSON.stringify({ action, id, ...params }))
    return web.wait((message) => message.type === 'result' && message.id === id)
  }
  const descriptor = JSON.parse(await readFile(join(directory, 'private/connection.json'), 'utf8'))
  const bridge = (id: string, target = port) =>
    new WebSocket(`ws://127.0.0.1:${target}/claude/channel`, {
      headers: { Authorization: `Bearer ${descriptor.token}`, 'X-Sparkle-Session': id }
    })
  const hook = async (id: string, nativeId: string, extra: CodexRecord = {}) =>
    fetch(`http://127.0.0.1:${port}/claude/hook`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${descriptor.token}`, 'X-Sparkle-Session': id },
      body: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: nativeId,
        cwd: directory,
        ...extra
      })
    })
  return {
    gateway,
    directory,
    base,
    origin,
    port,
    webPort,
    access,
    cookie,
    browser,
    web,
    action,
    descriptor,
    bridge,
    hook,
    starts,
    keys,
    kills: () => kills,
    close: async () => {
      await gateway.stop()
      await rm(directory, { recursive: true, force: true })
    }
  }
}

test('LAN web access needs no code while local bridge and origin boundaries remain enforced', async () => {
  const f = await fixture()
  try {
    assert.equal(f.access.available, true)
    assert.equal(f.access.code, undefined)
    const legacy = await fetch(`${f.base}/claude`, { redirect: 'manual' })
    assert.equal(legacy.status, 302)
    assert.equal(legacy.headers.get('location'), '/')
    assert.equal((await fetch(`${f.base}/claude/api/status`)).status, 200)
    const foreign = await fetch(`${f.base}/claude/api/access`, {
      headers: { 'Sec-Fetch-Site': 'cross-site' }
    }).then((r) => r.json())
    assert.equal(foreign.available, true)
    assert.equal(foreign.code, undefined)
    assert.equal(
      (
        await fetch(`${f.base}/claude/api/login`, {
          method: 'POST',
          headers: { Origin: f.origin },
          body: '{}'
        })
      ).status,
      404
    )
    for (const [path, port, headers] of [
      [
        '/claude/channel',
        f.webPort,
        { Authorization: `Bearer ${f.descriptor.token}`, 'X-Sparkle-Session': randomUUID() }
      ],
      [
        '/claude/channel',
        f.port,
        { Authorization: 'Bearer wrong', 'X-Sparkle-Session': randomUUID() }
      ],
      ['/claude/browser', f.webPort, { Origin: 'http://evil.invalid', Cookie: f.cookie }],
      ['/claude/browser', f.port, { Origin: `http://127.0.0.1:${f.port}`, Cookie: f.cookie }]
    ] as [string, number, Record<string, string>][]) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers })
      ws.on('error', () => {})
      const [, response] = await once(ws, 'unexpected-response')
      assert.equal(response.statusCode, 403)
      ws.terminate()
    }
    assert.equal((await fetch(`${f.base}/claude/hook`, { method: 'POST', body: '{}' })).status, 403)
  } finally {
    await f.close()
  }
})

test('owned native startup keeps confirmations; messages, approval, reconnect and context guards', async () => {
  const f = await fixture()
  try {
    const created = await f.action('create', { cwd: f.directory })
    assert.ok(created.result.sessionId)
    const id = created.result.sessionId,
      nativeId = randomUUID()
    assert.equal(f.starts.length, 1)
    assert.equal((await f.action('watch', { sessionId: id })).result.session.owned, true)
    assert.match(
      (await f.action('terminal', { sessionId: id, enabled: true })).result.data,
      /Native trust/
    )
    await f.action('confirm', { sessionId: id, key: 'enter' })
    assert.deepEqual(f.keys, ['\r'])
    assert.match(
      (await f.action('confirm', { sessionId: id, key: 'arbitrary text' })).error,
      /选择按键/
    )
    const backend = f.bridge(id),
      rpc = inbox(backend)
    await once(backend, 'open')
    backend.send(JSON.stringify({ type: 'hello', id, pid: 123, cwd: f.directory }))
    assert.equal((await f.hook(id, nativeId)).status, 200)
    await f.web.wait(
      (message) =>
        message.type === 'sessions' &&
        message.sessions.some(
          (s: CodexRecord) => s.id === id && s.connected && s.nativeId === nativeId
        )
    )
    assert.match((await f.action('confirm', { sessionId: id, key: 'enter' })).error, /选择按键/)
    const messageId = randomUUID()
    const sending = f.action('send', { sessionId: id, nativeId, messageId, text: 'Hello' })
    assert.equal((await rpc.wait((message) => message.type === 'message')).text, 'Hello')
    backend.send(JSON.stringify({ type: 'submitted', id: messageId }))
    assert.equal((await sending).result.message.state, 'submitted')
    backend.send(JSON.stringify({ type: 'reply', id: 'reply:1', messageId, text: 'Answer' }))
    assert.equal((await rpc.wait((message) => message.type === 'ack')).id, 'reply:1')
    assert.equal(
      (
        await f.web.wait(
          (message) => message.type === 'message' && message.message.role === 'assistant'
        )
      ).message.text,
      'Answer'
    )
    assert.equal(
      (await f.action('send', { sessionId: id, nativeId, messageId, text: 'Hello' })).result.message
        .state,
      'replied'
    )
    backend.send(
      JSON.stringify({
        type: 'permission',
        id: 'abcde',
        tool: 'Bash',
        description: 'Run a command',
        preview: 'pwd'
      })
    )
    await f.web.wait(
      (message) => message.type === 'permissions' && message.permissions.length === 1
    )
    assert.ok(
      (await f.action('verdict', { sessionId: id, nativeId, requestId: 'abcde', behavior: 'deny' }))
        .result
    )
    assert.equal((await rpc.wait((message) => message.type === 'verdict')).behavior, 'deny')
    assert.match(
      (
        await f.action('verdict', {
          sessionId: id,
          nativeId,
          requestId: 'abcde',
          behavior: 'allow'
        })
      ).error,
      /审批已处理/
    )
    backend.send(JSON.stringify({ type: 'verdictSent', requestId: 'abcde' }))
    await f.web.wait(
      (message) => message.type === 'permissions' && message.permissions.length === 0
    )
    const newNative = randomUUID()
    await f.hook(id, newNative)
    assert.match(
      (
        await f.action('send', {
          sessionId: id,
          nativeId,
          messageId: randomUUID(),
          text: 'wrong context'
        })
      ).error,
      /切换会话/
    )
    await f.hook(id, nativeId, { hook_event_name: 'Stop' })
    assert.equal((await f.action('watch', { sessionId: id })).result.session.nativeId, newNative)
    await f.hook(id, randomUUID(), { hook_event_name: 'SessionStart', agent_id: 'subagent' })
    assert.equal((await f.action('watch', { sessionId: id })).result.session.nativeId, newNative)
    backend.close()
    await once(backend, 'close')
    const replacement = f.bridge(id)
    await once(replacement, 'open')
    replacement.send(JSON.stringify({ type: 'hello', id, pid: 123, cwd: f.directory }))
    await f.web.wait(
      (message) =>
        message.type === 'sessions' &&
        message.sessions.some((s: CodexRecord) => s.id === id && s.connected)
    )
    assert.equal((await f.action('watch', { sessionId: id })).result.session.nativeId, newNative)
  } finally {
    await f.close()
    assert.equal(f.kills(), 1)
  }
})

test('official MCP stdio contract: capabilities, events, reply, permissions and reconnect', async () => {
  const f = await fixture(),
    id = randomUUID(),
    nativeId = randomUUID()
  const client = new Client({ name: 'channel-test', version: '1' }, { capabilities: {} })
  const notifications: CodexRecord[] = []
  let restarted: CodexGateway | undefined, restartedBrowser: WebSocket | undefined
  client.fallbackNotificationHandler = async (notification) => {
    notifications.push(notification)
  }
  const waitFor = async (predicate: () => boolean) => {
    const until = Date.now() + 7000
    while (!predicate()) {
      if (Date.now() > until) throw new Error('MCP timeout')
      await new Promise((resolve) => {
        setTimeout(resolve, 20)
      })
    }
  }
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        '--import',
        pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href,
        resolve('src/main/custom/claude-channel/entry.ts'),
        '--descriptor',
        join(f.directory, 'private/connection.json'),
        '--id',
        id
      ],
      cwd: f.directory,
      stderr: 'pipe'
    })
    await client.connect(transport)
    assert.ok(client.getServerCapabilities()?.experimental?.['claude/channel/permission'])
    assert.equal((await client.listTools()).tools[0].name, 'reply')
    await f.web.wait(
      (message) =>
        message.type === 'sessions' &&
        message.sessions.some((s: CodexRecord) => s.id === id && s.connected)
    )
    await f.hook(id, nativeId)
    await f.action('watch', { sessionId: id })
    const messageId = randomUUID()
    assert.equal(
      (await f.action('send', { sessionId: id, nativeId, messageId, text: 'MCP message' })).result
        .message.state,
      'submitted'
    )
    await waitFor(() => notifications.some((n) => n.method === 'notifications/claude/channel'))
    assert.equal(
      notifications.find((n) => n.method === 'notifications/claude/channel')!.params.content,
      'MCP message'
    )
    const reply = await client.callTool({
      name: 'reply',
      arguments: { message_id: messageId, text: 'MCP answer' }
    })
    assert.equal(reply.isError, undefined)
    assert.equal(
      (
        await f.web.wait(
          (message) => message.type === 'message' && message.message.role === 'assistant'
        )
      ).message.text,
      'MCP answer'
    )
    assert.equal(
      (
        await client.callTool({
          name: 'reply',
          arguments: { message_id: randomUUID(), text: 'invalid' }
        })
      ).isError,
      true
    )
    await client.notification({
      method: 'notifications/claude/channel/permission_request',
      params: {
        request_id: 'vwxyz',
        tool_name: 'Write',
        description: 'Write a file',
        input_preview: 'test.txt'
      }
    })
    await f.web.wait(
      (message) =>
        message.type === 'permissions' &&
        message.permissions.some((p: CodexRecord) => p.id === 'vwxyz')
    )
    await f.action('verdict', { sessionId: id, nativeId, requestId: 'vwxyz', behavior: 'deny' })
    await waitFor(() =>
      notifications.some((n) => n.method === 'notifications/claude/channel/permission')
    )
    assert.deepEqual(
      notifications.find((n) => n.method === 'notifications/claude/channel/permission')!.params,
      { request_id: 'vwxyz', behavior: 'deny' }
    )
    const replacement = f.bridge(id)
    replacement.on('error', () => {})
    await once(replacement, 'open')
    const replaced = once(replacement, 'close')
    replacement.send(JSON.stringify({ type: 'hello', id, pid: 456, cwd: f.directory }))
    await replaced // The original MCP bridge reconnects with the same instance ID.
    await waitFor(() =>
      f.web.messages.some(
        (message) =>
          message.type === 'sessions' &&
          message.sessions.some((s: CodexRecord) => s.id === id && s.connected)
      )
    )
    const second = randomUUID()
    const result = await f.action('send', {
      sessionId: id,
      nativeId,
      messageId: second,
      text: 'After reconnect'
    })
    assert.equal(result.result.message.state, 'submitted')
    await waitFor(() => notifications.some((n) => n.params?.meta?.message_id === second))
    await client.notification({
      method: 'notifications/claude/channel/permission_request',
      params: {
        request_id: 'rstuv',
        tool_name: 'Write',
        description: 'Pending across restart',
        input_preview: 'test.txt'
      }
    })
    await f.web.wait(
      (message) =>
        message.type === 'permissions' &&
        message.permissions.some((p: CodexRecord) => p.id === 'rstuv')
    )
    await f.gateway.stop()
    restarted = new CodexGateway({
      port: 0,
      webPort: 0,
      frontendDir: f.directory,
      version: 'restart-test',
      claude: {
        directory: join(f.directory, 'private'),
        bridgeFile: resolve('src/main/custom/claude-channel/entry.ts')
      }
    })
    await restarted.start()
    const webPort = restarted.ports().webPort,
      base = `http://127.0.0.1:${webPort}`
    restartedBrowser = new WebSocket(`ws://127.0.0.1:${webPort}/claude/browser`, {
      headers: { Origin: base, Cookie: f.cookie }
    })
    const next = inbox(restartedBrowser)
    await once(restartedBrowser, 'open')
    await next.wait(
      (message) =>
        message.type === 'sessions' &&
        message.sessions.some(
          (s: CodexRecord) => s.id === id && s.nativeId === nativeId && s.connected
        )
    )
    restartedBrowser.send(
      JSON.stringify({ id: 'watch-after-restart', action: 'watch', sessionId: id })
    )
    const watch = await next.wait((message) => message.id === 'watch-after-restart')
    assert.equal(watch.result.session.nativeId, nativeId)
    assert.equal(watch.result.permissions[0].id, 'rstuv')
    const third = randomUUID()
    restartedBrowser.send(
      JSON.stringify({
        id: 'send-after-restart',
        action: 'send',
        sessionId: id,
        nativeId,
        messageId: third,
        text: 'After gateway restart'
      })
    )
    assert.equal(
      (await next.wait((message) => message.id === 'send-after-restart')).result.message.state,
      'submitted'
    )
    await waitFor(() => notifications.some((n) => n.params?.meta?.message_id === third))
  } finally {
    await client.close()
    restartedBrowser?.terminate()
    await restarted?.stop()
    await f.close()
  }
})

test('Claude file previews use the native project, preserve provider links and reject stale sessions', async () => {
  const f = await fixture()
  try {
    const id = randomUUID(),
      nativeId = randomUUID()
    await writeFile(join(f.directory, 'readme.md'), '# Project preview')
    await f.hook(id, nativeId)
    const url = new URL(`${f.base}/api/file`)
    url.search = new URLSearchParams({
      provider: 'claude',
      sessionId: id,
      nativeId,
      path: './readme.md'
    }).toString()
    const response = await fetch(url)
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.kind, 'text')
    assert.equal(result.text, '# Project preview')
    assert.equal(new URL(result.downloadUrl, f.base).searchParams.get('provider'), 'claude')
    // Compaction may report a nested cwd; older project links must still open.
    const nested = join(f.directory, 'nested')
    await mkdir(nested)
    await f.hook(id, nativeId, { cwd: nested })
    url.searchParams.set('base', f.directory)
    assert.equal((await fetch(url)).status, 200)
    assert.equal((await fetch(url, { method: 'HEAD' })).status, 200)
    assert.equal((await fetch(url, { method: 'POST' })).status, 405)
    url.searchParams.set('nativeId', randomUUID())
    assert.equal((await fetch(url)).status, 404)
    url.searchParams.set('nativeId', nativeId)
    url.searchParams.set('path', '../')
    assert.equal((await fetch(url)).status, 403)
  } finally {
    await f.close()
  }
})

test('bounded byte-cursor transcript history, tools, channel dedup and partial rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude history ')),
    file = join(dir, 'session.jsonl')
  try {
    const lines = Array.from({ length: 35 }, (_, i) =>
      JSON.stringify({
        uuid: `row-${i}`,
        type: i % 2 ? 'assistant' : 'user',
        timestamp: new Date(i * 1000).toISOString(),
        message: { content: [{ type: 'text', text: `message ${i}` }] }
      })
    )
    await writeFile(file, lines.join('\n') + '\n')
    const latest = await claudeHistory(file)
    assert.equal(latest.items.length, 10)
    assert.equal(latest.items[0].text, 'message 25')
    const older = await claudeHistory(file, { before: latest.before })
    assert.equal(older.items[0].text, 'message 15')
    const newer = await claudeHistory(file, { after: older.after })
    assert.deepEqual(newer.items, latest.items)
    const first = await claudeHistory(file, {
      before: (await claudeHistory(file, { before: older.before })).before
    })
    assert.equal(first.items.length, 5)
    assert.equal(first.before, null)
    await assert.rejects(claudeHistory(file, { before: 'bad' }), /历史位置/)
    const id = randomUUID(),
      text = 'reply text'
    await writeFile(
      file,
      [
        JSON.stringify({
          type: 'user',
          message: { content: `<channel source="sparkle" message_id="${id}">hello</channel>` }
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'mcp__sparkle__reply', input: { message_id: id, text } }
            ]
          }
        }),
        JSON.stringify({
          uuid: 'tool',
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pwd' } }] }
        })
      ].join('\n') + '\n{"partial":'
    )
    const page = await claudeHistory(file)
    assert.equal(page.items.length, 3)
    assert.equal(page.items[0].id, `send:${id}`)
    assert.equal(page.items[1].id, replyId(id, text))
    assert.equal(page.items[2].role, 'tool')
    assert.ok(page.after)
    await assert.rejects(claudeHistory(file, { before: latest.before }), /历史记录已变化/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('launch settings are per-process, preserve existing scopes and native permission policy', () => {
  const descriptor = {
    version: 1 as const,
    runtime: '/runtime with spaces/node',
    bridge: '/bridge with spaces/channel.js',
    token: 'a'.repeat(64),
    url: 'ws://127.0.0.1:1234/claude/channel',
    hookUrl: 'http://127.0.0.1:1234/claude/hook'
  }
  const config = claudeLaunchConfig(descriptor, '/data with spaces/connection.json', randomUUID(), [
    '--resume',
    randomUUID()
  ])
  assert.ok(config.args.includes('--dangerously-load-development-channels'))
  assert.ok(!config.args.includes('--dangerously-skip-permissions'))
  const mcp = JSON.parse(config.args[config.args.indexOf('--mcp-config') + 1])
  assert.equal(mcp.mcpServers.sparkle.command, descriptor.runtime)
  assert.equal(mcp.mcpServers.sparkle.args[2], '/data with spaces/connection.json')
  const settings = JSON.parse(config.args[config.args.indexOf('--settings') + 1])
  assert.deepEqual(Object.keys(settings), ['hooks'])
  assert.equal(settings.hooks.SessionStart[0].hooks[0].onFailure, 'continue')
  assert.equal(settings.hooks.SessionStart[0].hooks[0].type, 'command')
  assert.match(settings.hooks.SessionStart[0].hooks[0].command, /--hook/)
  assert.equal(settings.hooks.MessageDisplay[0].hooks[0].type, 'http')
  for (const arg of ['-p', '--mcp-config', '--dangerously-skip-permissions'])
    assert.throws(() => claudeLaunchConfig(descriptor, 'connection.json', randomUUID(), [arg]))
})

test('plain claude gets channel defaults while native management and noninteractive commands keep their behavior', () => {
  for (const args of [
    [],
    ['--resume', 'session-id'],
    ['-c'],
    ['--model', 'sonnet'],
    ['hello world']
  ])
    assert.equal(shouldAttachClaude(args, true), true)
  for (const args of [
    ['--version'],
    ['--help'],
    ['auth', 'status'],
    ['update'],
    ['mcp', 'list'],
    ['-p', 'hello'],
    ['--print=hello'],
    ['--safe-mode'],
    ['--mcp-config', 'custom.json']
  ])
    assert.equal(shouldAttachClaude(args, true), false)
  assert.equal(shouldAttachClaude([], false), false)
})

test('default command opt-in preserves profile bytes, passes native args and probes without registering sessions', async () => {
  const f = await fixture(),
    directory = join(f.directory, 'default command')
  try {
    assert.equal(
      await publishDefaultCommand(
        join(f.directory, 'private/connection.json'),
        f.descriptor,
        directory
      ),
      false
    )
    await enableDefaultCommand(
      join(f.directory, 'private/connection.json'),
      f.descriptor,
      process.execPath,
      directory
    )
    const active = JSON.parse(await readFile(join(directory, 'active.json'), 'utf8'))
    assert.equal(active.descriptorFile, join(f.directory, 'private/connection.json'))
    const profile = join(f.directory, 'profile.ps1')
    const original = Buffer.from('\uFEFF# existing comment\r\n$myValue = "保留配置"', 'utf16le')
    await writeFile(profile, original)
    assert.equal(await appendDefaultCommandProfile(profile), true)
    const updated = await readFile(profile)
    assert.deepEqual(updated.subarray(0, original.length), original)
    assert.equal(await appendDefaultCommandProfile(profile), false)
    assert.deepEqual(await readFile(profile), updated)
    assert.equal(await channelAvailable(f.descriptor), true)
    assert.equal(
      (await fetch(`${f.base}/claude/api/status`).then((r) => r.json())).sessions.length,
      0
    )
    await f.gateway.stop()
    assert.equal(await channelAvailable(f.descriptor), false)
  } finally {
    await f.close()
  }
})

test(
  'native terminal worker releases handles after natural exit and explicit stop',
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sparkle pty worker '))
    const loader = createRequire(resolve('package.json')).resolve('tsx/cjs')
    const shim = join(directory, 'entry.cjs')
    await writeFile(
      shim,
      `require(${JSON.stringify(loader)}); require(${JSON.stringify(resolve('src/main/custom/claude-channel/entry.ts'))});`
    )
    try {
      for (const natural of [true, false]) {
        const child = spawn(process.execPath, [shim, '--terminal-worker'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        })
        const lines = createInterface({ input: child.stdout }),
          frames: CodexRecord[] = []
        lines.on('line', (line) => frames.push(JSON.parse(line)))
        let stderr = ''
        child.stderr.on('data', (bytes) => {
          stderr += bytes.toString()
        })
        const exited = once(child, 'exit')
        const timeout = setTimeout(() => {
          child.kill()
        }, 6000)
        try {
          const executable = process.platform === 'win32' ? process.env.ComSpec! : '/bin/sh'
          const args = natural
            ? process.platform === 'win32'
              ? ['/d', '/c', 'echo sparkle-pty-okay']
              : ['-c', 'printf sparkle-pty-okay']
            : process.platform === 'win32'
              ? ['/d', '/q']
              : []
          const env = { ...process.env }
          delete env.ELECTRON_RUN_AS_NODE
          child.stdin.write(
            JSON.stringify({ type: 'start', executable, args, cwd: directory, env }) + '\n'
          )
          if (!natural) {
            const until = Date.now() + 4000
            while (!frames.some((frame) => frame.type === 'ready') && Date.now() < until)
              await new Promise<void>((resolve) => {
                setTimeout(resolve, 20)
              })
            assert(
              frames.some((frame) => frame.type === 'ready'),
              stderr
            )
            child.stdin.end('{"type":"stop"}\n')
          }
          const [code] = await exited
          assert.equal(code, 0, JSON.stringify({ natural, stderr, frames }))
          assert(frames.some((frame) => frame.type === 'ready'))
          if (natural) {
            assert.match(
              frames
                .filter((frame) => frame.type === 'data')
                .map((frame) => frame.data)
                .join(''),
              /sparkle-pty-okay/
            )
            assert(frames.some((frame) => frame.type === 'exit'))
          }
        } finally {
          clearTimeout(timeout)
          lines.close()
          child.stdin.destroy()
          child.stdout.destroy()
          child.stderr.destroy()
          child.kill()
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
)
