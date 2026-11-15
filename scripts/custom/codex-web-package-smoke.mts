import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { extract, list } from 'tar'
import { WebSocket } from 'ws'

const root = resolve(import.meta.dirname, '../..')
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const names = [`sparkle-codex-web-${version}-node`]
if (process.platform === 'darwin' && process.arch === 'arm64') {
  names.push(`sparkle-codex-web-${version}-macos-arm64`)
}

async function availablePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  await new Promise<void>((done) => {
    server.close(() => done())
  })
  return port
}

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    try {
      const value = await read()
      if (accept(value)) return value
    } catch {
      /* Wait only for this isolated server to start. */
    }
    await delay(50)
  }
  throw new Error('Timed out waiting for packaged gateway')
}

for (const name of names) {
  const temporary = await mkdtemp(join(tmpdir(), 'sparkle-web-package test-'))
  try {
    const archive = join(root, 'dist', `${name}.tar.gz`)
    await list({
      file: archive,
      onReadEntry(entry) {
        if (entry.path.endsWith('/start.sh') || entry.path.endsWith('/runtime/node')) {
          assert.equal((entry.mode ?? 0) & 0o777, 0o755, `Executable permissions: ${entry.path}`)
        }
      }
    })
    await extract({ file: archive, cwd: temporary })
    const directory = join(temporary, name)
    await assert.rejects(access(join(directory, 'node_modules')))
    for (const file of [
      'LICENSE',
      'THIRD_PARTY_NOTICES.txt',
      'README.md',
      'start.sh',
      'start.cmd'
    ]) {
      assert.ok((await readFile(join(directory, file))).length > 0, file)
    }
    const embedded = name.endsWith('macos-arm64')
    const env = { ...process.env }
    delete env.NODE_PATH
    delete env.NODE_OPTIONS
    if (embedded) {
      env.PATH = '/usr/bin:/bin'
      assert.match(await readFile(join(directory, 'runtime', 'VERSION'), 'utf8'), /^v24\./)
      assert.ok((await readFile(join(directory, 'runtime', 'LICENSE'))).length > 1000)
    }
    const command = process.platform === 'win32' ? process.execPath : join(directory, 'start.sh')
    const prefix = process.platform === 'win32' ? [join(directory, 'server.cjs')] : []
    const options = {
      cwd: temporary,
      env,
      windowsHide: true,
      encoding: 'utf8' as const,
      timeout: 10000
    }
    assert.equal(execFileSync(command, [...prefix, '--version'], options).trim(), version)
    assert.match(execFileSync(command, [...prefix, '--help'], options), /--web-port/)
    assert.throws(() =>
      execFileSync(command, [...prefix, '--port', '0'], { ...options, stdio: 'pipe' })
    )
    const port = await availablePort()
    let webPort = await availablePort()
    while (webPort === port) webPort = await availablePort()
    const child = spawn(
      command,
      [...prefix, '--port', String(port), '--web-port', String(webPort)],
      {
        cwd: temporary,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let output = ''
    child.stdout.on('data', (data) => {
      output += data.toString()
    })
    child.stderr.on('data', (data) => {
      output += data.toString()
    })
    const exited = once(child, 'exit')
    let backend: WebSocket | undefined
    let browser: WebSocket | undefined
    const timer = setTimeout(() => child.kill('SIGKILL'), 25000)
    try {
      const base = `http://127.0.0.1:${webPort}`
      const status = await until(
        async () => (await fetch(`${base}/api/status`)).json(),
        (value) => value.ports?.webPort === webPort
      )
      assert.equal(status.ports.port, port)
      assert.match(await (await fetch(base)).text(), /Codex · Sparkle/)
      const assets = await readdir(join(directory, 'public', 'assets'))
      assert.ok(assets.some((file) => file.startsWith('syntax-worker-')))
      assert.ok(assets.some((file) => file.startsWith('file-formatted-')))
      for (const file of assets) {
        const response = await fetch(`${base}/assets/${file}`)
        assert.equal(response.status, 200, file)
        assert.deepEqual(
          Buffer.from(await response.arrayBuffer()),
          await readFile(join(directory, 'public', 'assets', file))
        )
      }
      backend = new WebSocket(`ws://127.0.0.1:${port}/codex/app-server`, {
        headers: {
          'x-codex-pid': String(process.pid),
          'x-codex-instance-id': 'package-smoke',
          'x-codex-runtime': 'standalone'
        }
      })
      const methods: string[] = []
      let handshake: unknown
      backend.on('message', (data) => {
        const message = JSON.parse(data.toString())
        methods.push(message.method)
        if (message.method === 'initialize') handshake = message.params
        if (message.id !== undefined)
          backend!.send(
            JSON.stringify({
              id: message.id,
              result: message.method === 'thread/loaded/list' ? { data: [], nextCursor: null } : {}
            })
          )
      })
      await once(backend, 'open')
      await until(
        async () => methods,
        (value) => value.includes('thread/loaded/list')
      )
      assert.deepEqual(handshake, {
        clientInfo: { name: 'codex-backend', title: 'Sparkle', version },
        capabilities: { experimentalApi: true, requiredHumanApproval: true }
      })
      assert.ok(methods.includes('initialized'))
      browser = new WebSocket(`ws://127.0.0.1:${webPort}/codex/browser`, { origin: base })
      const instances = once(browser, 'message')
      await once(browser, 'open')
      assert.equal(JSON.parse((await instances)[0].toString()).instances[0].id, 'package-smoke')
      console.log(
        `PASS ${name}: offline launch, assets, lazy worker, native handshake and browser WebSocket`
      )
    } catch (error) {
      console.error(output)
      throw error
    } finally {
      backend?.terminate()
      browser?.terminate()
      child.kill('SIGTERM')
      const [code] = await exited
      clearTimeout(timer)
      if (process.platform !== 'win32') assert.equal(code, 0, `Graceful shutdown: ${output}`)
    }
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
