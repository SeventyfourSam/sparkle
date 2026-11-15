import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { WebSocket } from 'ws'
import { CodexGateway } from './gateway'
import { CodexLauncher, codexCandidates, type CodexCommand } from './launcher'
import type { CodexRecord } from '../../../shared/codex-web'

const require = createRequire(import.meta.url)

async function fixture(options: { mode?: string; timeout?: number; missing?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sparkle codex launch-'))
  const childScript = join(directory, 'fake-codex.cjs')
  const starts = join(directory, 'starts.jsonl')
  await writeFile(join(directory, 'codex.html'), 'Codex launch fixture')
  await writeFile(
    childScript,
    `
const { WebSocket } = require(${JSON.stringify(require.resolve('ws'))})
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(starts)}, JSON.stringify({ pid: process.pid, args, cwd: process.cwd() }) + '\\n')
const mode = args.shift()
if (mode === 'exit') { process.exit(7) }
const port = args.find(arg => arg.startsWith('web_server_port=')).split('=')[1]
process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
if (mode !== 'hang') {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/codex/app-server', { headers: {
    'x-codex-instance-id': 'managed-' + process.pid,
    'x-codex-pid': String(process.pid),
    'x-codex-runtime': 'standalone'
  } })
  ws.on('error', () => {})
  ws.on('message', bytes => {
    const msg = JSON.parse(bytes.toString())
    if (msg.id === undefined) return
    let result = {}
    if (msg.method === 'thread/loaded/list' || msg.method === 'thread/list') result = { data: [], nextCursor: null }
    if (msg.method === 'thread/start') result = { thread: { id: 'new-thread', cwd: msg.params.cwd, turns: [], status: { type: 'idle' } } }
    const reply = () => ws.send(JSON.stringify({ id: msg.id, result }))
    if (msg.method === 'initialize') setTimeout(reply, 100)
    else reply()
  })
}
`
  )
  let resolutions = 0
  let mode = options.mode || 'ready'
  const command = async (): Promise<CodexCommand> => {
    resolutions++
    return {
      file: options.missing ? join(directory, 'not-installed.exe') : process.execPath,
      args: [childScript, mode]
    }
  }
  const gateway = new CodexGateway({
    port: 0,
    webPort: 0,
    frontendDir: directory,
    version: 'test',
    codexCommand: command,
    codexStartupTimeoutMs: options.timeout ?? 4000
  })
  const port = await gateway.start()
  const clients: WebSocket[] = []
  const browser = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${gateway.ports().webPort}/codex/browser`, {
      origin: `http://127.0.0.1:${gateway.ports().webPort}`
    })
    clients.push(socket)
    const pending = new Map<string, (message: CodexRecord) => void>()
    socket.on('message', (bytes) => {
      const message = JSON.parse(bytes.toString())
      if (message.type === 'result') pending.get(message.id)?.(message)
    })
    await once(socket, 'open')
    let sequence = 0
    return (action: string, params: CodexRecord = {}): Promise<CodexRecord> =>
      new Promise((resolve, reject) => {
        const id = String(++sequence)
        const timer = setTimeout(() => reject(new Error('Test browser timed out')), 7000)
        pending.set(id, (message) => {
          clearTimeout(timer)
          pending.delete(id)
          resolve(message)
        })
        socket.send(JSON.stringify({ id, action, ...params }))
      })
  }
  return {
    directory,
    gateway,
    port,
    command,
    browser,
    resolutions: () => resolutions,
    setMode: (value: string) => {
      mode = value
    },
    starts: async () =>
      (await readFile(starts, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    close: async () => {
      for (const client of clients) client.terminate()
      await gateway.stop()
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
}

test('executable search supports macOS GUI installs and Windows custom binaries without shell wrappers or project-relative PATH', () => {
  const mac = codexCandidates(
    'darwin',
    { PATH: '.:/opt/homebrew/bin:/usr/local/bin:/opt/homebrew/bin' },
    '/Users/demo'
  )
  assert.equal(mac[0], '/Users/demo/.local/bin/codex')
  assert(mac.includes('/opt/homebrew/bin/codex'))
  assert.equal(mac.filter((path) => path === '/opt/homebrew/bin/codex').length, 1)
  assert(!mac.includes('codex'))
  const windows = codexCandidates(
    'win32',
    { Path: 'C:\\tools;;.\\project', LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local' },
    'C:\\Users\\demo'
  )
  assert.equal(windows[0], 'C:\\Users\\demo\\AppData\\Local\\Programs\\CodexCustom\\bin\\codex.exe')
  assert(windows.includes('C:\\tools\\codex.exe'))
  assert(windows.every((path) => path.endsWith('codex.exe')))
})

test('two browsers start one Codex with the selected directory and actual gateway port, then create and reuse it', async () => {
  const f = await fixture()
  try {
    const [a, b] = await Promise.all([f.browser(), f.browser()])
    const [first, second] = await Promise.all([
      a('ensure', { cwd: f.directory }),
      b('ensure', { cwd: f.directory })
    ])
    assert.equal(first.error, undefined)
    assert.equal(second.result.instanceId, first.result.instanceId)
    assert.equal(f.resolutions(), 1)
    assert.equal((await f.starts()).length, 1)
    assert.deepEqual((await f.starts())[0].args, [
      'ready',
      'app-server',
      '-c',
      `web_server_port=${f.port}`
    ])
    assert.equal(await realpath((await f.starts())[0].cwd), await realpath(f.directory))
    assert.equal(
      (await a('sessions', { instanceId: first.result.instanceId, cwd: f.directory })).error,
      undefined
    )
    const created = await a('create', { instanceId: first.result.instanceId, cwd: f.directory })
    assert.equal(created.result.thread.cwd, f.directory)
    assert.equal(created.result.instanceId, first.result.instanceId)
    assert.equal(
      (await b('ensure', { cwd: f.directory })).result.instanceId,
      first.result.instanceId
    )
    const pid = (await f.starts())[0].pid
    await f.gateway.stop()
    assert.throws(() => process.kill(pid, 0), /ESRCH/)
  } finally {
    await f.close()
  }
})

test('create without an instance starts Codex, but an invalid directory or explicit offline selection does not launch', async () => {
  const f = await fixture()
  try {
    const action = await f.browser()
    assert.match(
      (await action('ensure', { cwd: join(f.directory, 'missing') })).error,
      /目录不存在/
    )
    assert.match(
      (await action('create', { instanceId: 'offline', cwd: f.directory })).error,
      /尚未连接/
    )
    assert.equal(f.resolutions(), 0)
    const created = await action('create', { cwd: f.directory })
    assert.equal(created.error, undefined)
    assert.ok(created.result.instanceId)
    assert.equal(f.resolutions(), 1)
  } finally {
    await f.close()
  }
})

test('a failed child can be retried, and a timed-out or missing executable leaves no child running', async () => {
  const f = await fixture({ mode: 'exit' })
  try {
    const action = await f.browser()
    assert.match((await action('ensure', { cwd: f.directory })).error, /启动后退出/)
    f.setMode('ready')
    assert.equal((await action('ensure', { cwd: f.directory })).error, undefined)
    assert.equal(f.resolutions(), 2)
  } finally {
    await f.close()
  }
  const hanging = await fixture({ mode: 'hang', timeout: 1000 })
  try {
    const action = await hanging.browser()
    assert.match((await action('ensure', { cwd: hanging.directory })).error, /接入超时/)
    const pid = (await hanging.starts())[0].pid
    assert.throws(() => process.kill(pid, 0), /ESRCH/)
  } finally {
    await hanging.close()
  }
  const missing = await fixture({ missing: true })
  try {
    assert.match(
      (await (await missing.browser())('ensure', { cwd: missing.directory })).error,
      /无法启动/
    )
  } finally {
    await missing.close()
  }
})

test('existing external Codex is reused and remains running when the gateway stops', async () => {
  const f = await fixture()
  let external: ChildProcess | undefined
  try {
    const command = await f.command()
    external = spawn(
      command.file,
      [...(command.args || []), 'app-server', '-c', `web_server_port=${f.port}`],
      { cwd: f.directory, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true }
    )
    for (let i = 0; !f.gateway.snapshot().some((instance) => instance.connected) && i < 100; i++)
      await delay(25)
    const instance = f.gateway.snapshot().find((instance) => instance.connected)!
    assert.ok(instance)
    const action = await f.browser()
    assert.equal(
      (await action('ensure', { cwd: f.directory, instanceId: instance.id })).result.instanceId,
      instance.id
    )
    assert.equal(f.resolutions(), 1)
    await f.gateway.stop()
    assert.equal(external.exitCode, null)
    process.kill(external.pid!, 0)
  } finally {
    if (external && external.exitCode === null) {
      const exit = once(external, 'exit')
      external.stdin?.end()
      await exit
    }
    await f.close()
  }
})

test('an owned server that exits can be launched again on the next request', async () => {
  const f = await fixture()
  try {
    const action = await f.browser()
    const first = await action('ensure', { cwd: f.directory })
    const pid = (await f.starts())[0].pid
    process.kill(pid, 'SIGTERM')
    for (let i = 0; f.gateway.snapshot().some((instance) => instance.connected) && i < 100; i++)
      await delay(25)
    const second = await action('ensure', { cwd: f.directory })
    assert.equal(second.error, undefined)
    assert.notEqual(second.result.instanceId, first.result.instanceId)
    assert.equal(f.resolutions(), 2)
  } finally {
    await f.close()
  }
})

test('stopping while executable discovery is pending prevents a later launch', async () => {
  let resolveCommand!: (value: CodexCommand) => void
  const launcher = new CodexLauncher({
    instances: () => [],
    command: () =>
      new Promise((resolve) => {
        resolveCommand = resolve
      })
  })
  const pending = launcher.ensure(tmpdir(), 38471)
  await launcher.stop()
  resolveCommand({ file: 'must-not-be-started' })
  await assert.rejects(pending, /正在停止/)
})
