import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as config from './config'
import * as shared from '../../../shared/codex-web'
import type { CodexWebOptions, CodexWebStatus } from '../../../shared/codex-web'

test('port settings only access Sparkle preferences and a failed change restores the previous service', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sparkle-web-preferences-'))
  const file = join(home, 'custom-codex-web.json')
  const servers: { port: number; webPort: number; stopped: boolean }[] = []
  let failSave = false
  let handle!: (event: unknown, action: string, value?: CodexWebOptions) => Promise<CodexWebStatus>
  try {
    await writeFile(
      file,
      JSON.stringify({
        port: 38471,
        webPort: 38472,
        enabled: false,
        codexHome: 'unused-legacy-value'
      })
    )
    const source = ts.transpileModule(
      readFileSync(join(import.meta.dirname, 'manager.ts'), 'utf8'),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true
        }
      }
    ).outputText
    const mocks: Record<string, unknown> = {
      electron: {
        app: { getVersion: () => 'test', once: () => {} },
        ipcMain: {
          handle: (_name: string, callback: typeof handle) => {
            handle = callback
          }
        }
      },
      'node:path': { join },
      '../../../shared/codex-web': shared,
      '../../utils/dirs': { dataDir: () => home },
      '../../utils/log': { appendAppLog: async () => {} },
      './config': {
        ...config,
        readOptions: async (path: string) => {
          assert.equal(path, file)
          return config.readOptions(path)
        },
        writeJsonAtomically: async (path: string, value: unknown) => {
          assert.equal(path, file)
          if (failSave) throw new Error('fixture disk full')
          await config.writeJsonAtomically(path, value)
        }
      },
      './gateway': {
        CodexGateway: class {
          state: (typeof servers)[number]
          constructor(value: CodexWebOptions) {
            this.state = { port: value.port, webPort: value.webPort, stopped: false }
            servers.push(this.state)
          }
          async start(): Promise<void> {
            assert.equal(this.state.stopped, false)
          }
          async stop(): Promise<void> {
            this.state.stopped = true
          }
        }
      }
    }
    const module = { exports: {} }
    runInNewContext(source, {
      module,
      exports: module.exports,
      __dirname: home,
      require: (name: string) => {
        assert.ok(name in mocks, `Unexpected dependency: ${name}`)
        return mocks[name]
      }
    })
    const manager = module.exports as typeof import('./manager')
    const initial = manager.initCodexWeb()
    const initialStatus = handle(undefined, 'status')
    await initial
    assert.equal((await initialStatus).running, true)
    assert.deepEqual((await initialStatus).options, { port: 38471, webPort: 38472 })
    const next = { port: 38473, webPort: 38474 }
    assert.equal((await handle(undefined, 'save', next)).running, true)
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), next)
    assert.deepEqual(await readdir(home), ['custom-codex-web.json'])
    await assert.rejects(handle(undefined, 'configure'), /无效/)
    failSave = true
    await assert.rejects(handle(undefined, 'save', { port: 38475, webPort: 38476 }), /disk full/)
    assert.equal(manager.keepCodexWebAlive(), true)
    assert.deepEqual((await handle(undefined, 'status')).options, next)
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), next)
    assert.equal(servers.at(-2)?.stopped, true)
    assert.deepEqual(servers.at(-1), { ...next, stopped: false })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
