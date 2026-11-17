import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { enableDefaultCommand } from './default-command'

test(
  'default launchers open an archived bridge through Electron and fall back when the archive is removed',
  { timeout: 30000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sparkle archived command '))
    const load = createRequire(resolve('package.json'))
    const asar = createRequire(load.resolve('electron-builder'))('@electron/asar') as {
      createPackage: (source: string, target: string) => Promise<void>
    }
    const runtime = load('electron') as string
    const input = join(directory, 'input'),
      archive = join(directory, 'app.asar')
    const commandDirectory = join(directory, 'default command')
    try {
      await mkdir(input)
      await writeFile(
        join(input, 'bridge.js'),
        'console.log("archived:" + JSON.stringify(process.argv.slice(2)))'
      )
      await asar.createPackage(input, archive)
      const descriptor = {
        version: 1 as const,
        runtime,
        bridge: join(archive, 'bridge.js'),
        url: 'ws://127.0.0.1:1/claude/channel',
        hookUrl: 'http://127.0.0.1:1/claude/hook',
        token: 'a'.repeat(64)
      }
      const descriptorFile = join(directory, 'connection.json')
      await enableDefaultCommand(descriptorFile, descriptor, process.execPath, commandDirectory)
      const active = JSON.parse(await readFile(join(commandDirectory, 'active.json'), 'utf8'))
      assert.equal(active.bridge, descriptor.bridge)
      assert.equal(active.bridgeContainer, archive)
      const run = promisify(execFile)
      const invoke = (args: string[]) => {
        const launcher = join(
          commandDirectory,
          'bin',
          process.platform === 'win32' ? 'claude.cmd' : 'claude'
        )
        return process.platform === 'win32'
          ? run(process.env.ComSpec!, ['/d', '/s', '/c', `""${launcher}" ${args.join(' ')}"`], {
              windowsHide: true,
              windowsVerbatimArguments: true,
              timeout: 15000
            })
          : run(launcher, args, { timeout: 15000 })
      }
      const nativeArgs = ['--model', 'example']
      const result = await invoke(nativeArgs)
      const expected = ['--launch-default', '--descriptor', descriptorFile, '--', ...nativeArgs]
      assert.deepEqual(JSON.parse(result.stdout.trim().slice('archived:'.length)), expected)
      if (process.platform === 'win32') {
        const bootstrap = join(commandDirectory, 'command.ps1').replace(/'/g, "''")
        const powershell = await run(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', `. '${bootstrap}'; claude --model example`],
          { windowsHide: true, timeout: 15000 }
        )
        assert.deepEqual(JSON.parse(powershell.stdout.trim().slice('archived:'.length)), expected)
      }
      await unlink(archive)
      assert.equal((await invoke(['--version'])).stdout.trim(), process.version)
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
)
