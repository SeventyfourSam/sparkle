import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { stringify } from 'yaml'
import { load } from './test-utils'
import type { PreparedProfile } from './profile-builder'

const binary = path.resolve(`extra/sidecar/mihomo${process.platform === 'win32' ? '.exe' : ''}`)

async function listen(server: net.Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return (server.address() as net.AddressInfo).port
}

async function availablePort(): Promise<number> {
  const server = net.createServer()
  const port = await listen(server)
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
  return port
}

test(
  'real Mihomo: failed preflight preserves the running core and hot reload preserves an established TCP connection',
  {
    skip: !existsSync(binary),
    timeout: 20_000
  },
  async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sparkle-reload-test-'))
    const echo = net.createServer((socket) => socket.pipe(socket))
    const echoPort = await listen(echo)
    const controllerPort = await availablePort()
    const mixedPort = await availablePort()
    const config = {
      'mixed-port': mixedPort,
      'external-controller': `127.0.0.1:${controllerPort}`,
      'bind-address': '127.0.0.1',
      'allow-lan': false,
      mode: 'rule',
      'log-level': 'info',
      'udp-fallback': false,
      tun: { enable: false },
      dns: { enable: false },
      proxies: [],
      'proxy-groups': [],
      rules: ['MATCH,DIRECT']
    }
    const file = path.join(directory, 'config.yaml')
    const original = stringify(config)
    await writeFile(file, original)
    const child = spawn(binary, ['-d', directory, '-f', file], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    let phase = 'startup'
    const capture = (data: Buffer): void => {
      output = (output + data.toString()).slice(-16_384)
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)
    const address = `http://127.0.0.1:${controllerPort}`
    let connection: net.Socket | undefined
    try {
      let ready = false
      for (let i = 0; i < 60; i++) {
        try {
          const response = await fetch(`${address}/version`, { signal: AbortSignal.timeout(500) })
          if (response.ok) {
            ready = true
            break
          }
        } catch {
          /* wait for the isolated child */
        }
        await delay(50)
      }
      assert.equal(ready, true, 'isolated Mihomo controller must become ready')
      const pid = child.pid
      // The controller and mixed-port listeners open before OnRunning. Wait
      // for actual forwarding, not merely /version, before tracking a session.
      let startupError: unknown
      for (let i = 0; i < 60; i++) {
        const socket = net.connect(mixedPort, '127.0.0.1')
        socket.on('error', () => {})
        try {
          await once(socket, 'connect', { signal: AbortSignal.timeout(1000) })
          const handshake = once(socket, 'data', { signal: AbortSignal.timeout(1000) })
          socket.write(
            `CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`
          )
          assert.match(String((await handshake)[0]), /200/)
          const warmup = once(socket, 'data', { signal: AbortSignal.timeout(1000) })
          socket.write('ready')
          assert.equal(String((await warmup)[0]), 'ready')
          connection = socket
          break
        } catch (error) {
          startupError = error
          socket.destroy()
          await delay(50)
        }
      }
      assert.ok(connection, `forwarding must become ready: ${startupError}`)
      const exchange = async (message: string): Promise<void> => {
        assert.equal(connection!.destroyed, false, `connection lost during ${phase}`)
        const response = once(connection!, 'data', { signal: AbortSignal.timeout(3000) })
        connection!.write(message)
        assert.equal(String((await response)[0]), message)
      }
      await exchange('before reload')

      phase = 'rejected preflight'
      const preflight = load<typeof import('./profile-check')>('profile-check.ts', {
        '../utils/dirs': { mihomoCorePath: () => binary },
        '../core/startup-chain': { createCoreEnvironment: () => ({ ...process.env }) }
      })
      const candidate = (yaml: string): PreparedProfile =>
        ({
          yaml,
          workDir: directory,
          configPath: file,
          appConfig: { core: 'mihomo' }
        }) as PreparedProfile
      const invalid = stringify({ ...config, rules: ['MATCH,missing-proxy'] })
      await assert.rejects(preflight.checkProfile(candidate(invalid)), /配置预检失败/)
      assert.equal(await readFile(file, 'utf8'), original)
      assert.equal(child.exitCode, null)
      assert.equal((await fetch(`${address}/configs`)).status, 200)
      await exchange('after rejected preflight')

      phase = 'successful preflight'
      const updated = stringify({ ...config, 'udp-fallback': true })
      await preflight.checkProfile(candidate(updated))
      assert.equal(await readFile(file, 'utf8'), original, 'successful preflight is also read-only')
      const response = await fetch(`${address}/configs?force=true`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: updated })
      })
      assert.equal(response.status, 204)
      const actual = await (await fetch(`${address}/configs`)).json()
      assert.equal(actual['udp-fallback'], true)
      assert.equal(child.pid, pid)
      assert.equal(child.exitCode, null)
      phase = 'after hot reload'
      await exchange('same connection after reload')
    } catch (error) {
      t.diagnostic(`Failed during ${phase}\n${output}`)
      throw error
    } finally {
      connection?.destroy()
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill()
        await exited
      }
      await new Promise<void>((resolve) => {
        echo.close(() => resolve())
      })
      // Resolved from mkdtemp, exclusively owned by this test.
      await rm(directory, { recursive: true, force: true })
    }
  }
)
