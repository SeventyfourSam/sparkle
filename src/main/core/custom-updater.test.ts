import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const previous = { path: '/managed/old/mihomo', version: 'v1.19.33-custom.2' }
const next = { path: '/managed/new/mihomo', version: 'v1.19.34-custom.1' }

function fixture(
  options: {
    core?: AppConfig['core']
    currentVersion?: string
    downloadFailure?: boolean
    permissionFailure?: boolean
    startupFailure?: boolean
    changeDuringDownload?: boolean
  } = {}
) {
  let config = {
    core: options.core ?? 'mihomo',
    corePermissionMode: 'elevated',
    customMihomo: previous
  } as AppConfig
  const events: string[] = []
  let starts = 0
  const mocks = {
    '../config': {
      getAppConfig: async () => config,
      getControledMihomoConfig: async () => ({ 'mixed-port': 0 }),
      patchAppConfig: async (patch: Partial<AppConfig>) => {
        events.push(`save:${patch.customMihomo?.version}`)
        config = { ...config, ...patch }
      }
    },
    'node:fs/promises': {
      mkdtemp: async () => '/fake/temp',
      writeFile: async () => events.push('stage'),
      rm: async () => events.push('cleanup')
    },
    '../custom/paths': { localCoreDir: () => '/managed' },
    '../utils/log': { appendAppLog: async () => {} },
    '../../shared/mihomo-release': {
      getMihomoRelease: async () => ({ version: next.version, executableName: 'mihomo' }),
      downloadMihomoRelease: async () => {
        events.push('download-and-verify')
        if (options.downloadFailure) throw new Error('checksum failure')
        if (options.changeDuringDownload) config = { ...config, core: 'system' }
        return Buffer.from('verified executable')
      }
    },
    './local-core': {
      importLocalCore: async () => {
        events.push('import')
        return next.path
      },
      ensureLocalCorePermission: async () => {
        events.push('grant')
        if (options.permissionFailure) throw new Error('permission cancelled')
      }
    },
    './mihomoApi': {
      mihomoVersion: async () => ({
        version: starts
          ? config.customMihomo?.version
          : (options.currentVersion ?? previous.version)
      })
    },
    './manager': {
      stopCore: async () => events.push('stop'),
      startCore: async () => {
        events.push(`start:${config.customMihomo?.version}`)
        starts++
        if (options.startupFailure && starts === 1) throw new Error('startup failure')
        return [Promise.resolve()]
      }
    },
    'node:os': { tmpdir: () => '/fake' },
    'node:path': path
  }
  const filename = path.join(import.meta.dirname, 'custom-updater.ts')
  const output = ts.transpileModule(readFileSync(filename, 'utf-8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText
  const module = { exports: {} as typeof import('./custom-updater') }
  runInNewContext(output, {
    module,
    exports: module.exports,
    require: (id: string) => mocks[id] ?? {},
    process: { platform: 'darwin', arch: 'arm64' },
    Buffer
  })
  return { update: module.exports.upgradeCustomMihomo, events, config: () => config }
}

test('verifies and authorizes the candidate before stopping, then starts and checks the new core', async () => {
  const f = fixture()
  await f.update()
  assert.deepEqual(f.events, [
    'download-and-verify',
    'stage',
    'import',
    'grant',
    'stop',
    `save:${next.version}`,
    `start:${next.version}`,
    'cleanup'
  ])
  assert.equal(f.config().core, 'mihomo')
  assert.deepEqual({ ...f.config().customMihomo }, next)
})

test('checksum failure and cancelled authorization preserve the current core and settings', async () => {
  for (const options of [{ downloadFailure: true }, { permissionFailure: true }]) {
    const f = fixture(options)
    await assert.rejects(f.update())
    assert.equal(f.events.includes('stop'), false)
    assert.equal(f.config().customMihomo, previous)
  }
})

test('startup failure restores the old path and restarts the previous core', async () => {
  const f = fixture({ startupFailure: true })
  await assert.rejects(f.update(), /startup failure/)
  assert.deepEqual(f.config().customMihomo, previous)
  assert.deepEqual(f.events.slice(-5), [
    `start:${next.version}`,
    'stop',
    `save:${previous.version}`,
    `start:${previous.version}`,
    'cleanup'
  ])
})

test('unchanged versions and external cores never start a download or stop the core', async () => {
  for (const options of [{ currentVersion: next.version }, { core: 'system' as const }]) {
    const f = fixture(options)
    await assert.rejects(f.update())
    assert.deepEqual(f.events, [])
  }
})

test('changing the selected core during download prevents activation', async () => {
  const f = fixture({ changeDuringDownload: true })
  await assert.rejects(f.update(), /设置已变更/)
  assert.equal(f.events.includes('stop'), false)
  assert.equal(f.config().core, 'system')
})
