import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { deepMerge } from '../utils/merge'

const nativeRequire = createRequire(import.meta.url)

// Run the actual modules with OS/app boundaries stubbed: never prompt, stop a real
// core, write user settings, or change DNS during these regression tests.
function load<T>(file: string, mocks: Record<string, unknown>, platform = 'darwin'): T {
  const filename = path.join(import.meta.dirname, file)
  const output = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText
  const module = { exports: {} }
  runInNewContext(
    output,
    {
      module,
      exports: module.exports,
      require: (id: string) => mocks[id] ?? (isBuiltin(id) ? nativeRequire(id) : {}),
      process: { platform, env: {} },
      Buffer,
      structuredClone,
      setTimeout,
      clearTimeout
    },
    { filename }
  )
  return module.exports as T
}

function permissionFixture(platform = 'darwin', uid = 501, mode = 0o500) {
  const calls: { file: string; args: string[] }[] = []
  const state = { uid, mode, regular: true, fail: false, ineffective: false }
  const core = load<typeof import('./local-core')>(
    './local-core.ts',
    {
      'node:fs/promises': { lstat: async () => ({ ...state, isFile: () => state.regular }) },
      'node:child_process': {
        execFile: (file: string, args: string[], callback: (error: Error | null) => void) => {
          calls.push({ file, args })
          if (state.fail) return callback(new Error('User canceled (-128)'))
          if (!state.ineffective) Object.assign(state, { uid: 0, mode: 0o4555 })
          callback(null)
        }
      }
    },
    platform
  )
  return { ...core, calls, state }
}

test('local permission grant sets root/setuid, rechecks it, and is idempotent', async () => {
  const fixture = permissionFixture()
  await fixture.ensureLocalCorePermission('/managed/local-one/mihomo')
  assert.equal(fixture.calls.length, 1)
  assert.equal(fixture.state.uid, 0)
  assert.equal(fixture.state.mode, 0o4555)
  await fixture.ensureLocalCorePermission('/managed/local-one/mihomo')
  assert.equal(fixture.calls.length, 1)
})

test('non-root setuid, root without execute permission, and writable binaries need a grant', async () => {
  for (const [uid, mode] of [
    [501, 0o4555],
    [0, 0o4500],
    [0, 0o4777]
  ]) {
    const fixture = permissionFixture('darwin', uid, mode)
    await fixture.ensureLocalCorePermission('/managed/local-one/mihomo')
    assert.equal(fixture.calls.length, 1)
  }
})

test('cancelled or ineffective authorization fails and symlinks are rejected', async () => {
  for (const kind of ['fail', 'ineffective'] as const) {
    const fixture = permissionFixture()
    fixture.state[kind] = true
    await assert.rejects(fixture.ensureLocalCorePermission('/managed/local-one/mihomo'), /授权失败/)
  }
  const fixture = permissionFixture()
  fixture.state.regular = false
  await assert.rejects(fixture.ensureLocalCorePermission('/managed/local-one/mihomo'), /普通文件/)
  assert.equal(fixture.calls.length, 0)
})

test(
  'macOS and Linux grant commands quote paths literally; Windows has no setuid prompt',
  { skip: process.platform === 'win32' },
  async () => {
    const corePath = '/managed/空 格\'"$HOME`printf injected`$(printf injected)\\/local-one/mihomo'
    for (const platform of ['darwin', 'linux']) {
      const fixture = permissionFixture(platform)
      await fixture.ensureLocalCorePermission(corePath)
      const call = fixture.calls[0]
      const shell =
        platform === 'darwin'
          ? JSON.parse(
              call.args[1].slice(
                'do shell script '.length,
                -' with administrator privileges'.length
              )
            )
          : call.args[2]
      assert.equal(call.file, platform === 'darwin' ? '/usr/bin/osascript' : 'pkexec')
      // Replace only the program names with an inert recorder, then parse via a real shell.
      const inert = shell
        .replace(/(?:\/usr\/sbin\/)?chown /, 'record ')
        .replace(/(?:\/bin\/)?chmod /, 'record ')
      const result = execFileSync('/bin/sh', ['-c', `record() { printf '%s\\0' "$@"; }; ${inert}`])
      assert.deepEqual(result.toString().split('\0'), [
        platform === 'darwin' ? 'root:admin' : 'root:root',
        corePath,
        '4555',
        corePath,
        ''
      ])
      if (platform === 'darwin' && process.platform === 'darwin') {
        const script = `record() { printf '%s\\n' "$@"; }; ${inert}`
        const appleScript = execFileSync(
          '/usr/bin/osascript',
          ['-e', `do shell script ${JSON.stringify(script)}`],
          { encoding: 'utf8' }
        )
        assert.equal(
          appleScript.replaceAll('\r', '\n'),
          ['root:admin', corePath, '4555', corePath, ''].join('\n')
        )
      }
    }
    const windows = permissionFixture('win32')
    await windows.ensureLocalCorePermission('C:\\managed\\mihomo.exe')
    assert.equal(windows.calls.length, 0)
  }
)

function ipcFixture(current: Partial<AppConfig>, cancelled = false) {
  const events: string[] = []
  const config = { sysProxy: { enable: false }, ...current }
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const customConfig = load<typeof import('../custom/config')>('../custom/config.ts', {
    './paths': { localCoreDir: () => '/managed' },
    '../core/local-core': {
      importLocalCore: async (source: string) => {
        events.push(`import:${source}`)
        return '/managed/local-one/mihomo'
      },
      ensureLocalCorePermission: async (file: string) => {
        events.push(`grant:${file}`)
        if (cancelled) throw new Error('用户取消操作')
      }
    },
    '../sys/mihomo-system-dns': {
      prepareMihomoSystemDnsAppPatch: async (patch: unknown) => {
        events.push('dns-prepare')
        return patch
      }
    }
  })
  const appConfig = load<typeof import('../config/app')>('../config/app.ts', {
    '../custom/config': customConfig,
    '../utils/dirs': { appConfigPath: () => '/managed/config' },
    '../utils/yaml': { parseYaml: JSON.parse, stringifyYaml: JSON.stringify },
    '../utils/merge': { deepMerge },
    '../utils/template': { defaultConfig: config },
    '../resolve/webhook': { notifyConfigOperation: () => {} },
    fs: { existsSync: () => false },
    'fs/promises': {
      readFile: async () => JSON.stringify(config),
      writeFile: async (_file: string, data: string) => {
        events.push('save')
        Object.assign(config, JSON.parse(data))
      }
    }
  })
  const ready = appConfig.getAppConfig()
  const ipc = load<{ registerIpcMainHandlers: () => void }>('../utils/ipc.ts', {
    '../resolve/webhook': { webhookOperationCategories: new Map() },
    electron: {
      ipcMain: {
        handle: (name: string, fn: (...args: unknown[]) => Promise<unknown>) =>
          handlers.set(name, fn)
      }
    },
    '../config': appConfig
  })
  ipc.registerIpcMainHandlers()
  return {
    events,
    config,
    patch: async (patch: Partial<AppConfig>) => {
      await ready
      return handlers.get('patchAppConfig')!(null, patch)
    },
    directPatch: async (patch: Partial<AppConfig>) => {
      await ready
      return appConfig.patchAppConfig(patch)
    }
  }
}

test('IPC authorizes the imported copy before changing config or DNS', async () => {
  const fixture = ipcFixture({ core: 'mihomo' })
  await fixture.patch({ core: 'system', systemCorePath: '/source/custom' })
  assert.deepEqual(fixture.events, [
    'import:/source/custom',
    'grant:/managed/local-one/mihomo',
    'dns-prepare',
    'save'
  ])
  assert.equal(fixture.config.systemCorePath, '/managed/local-one/mihomo')
})

test('direct app config writes share the same import and DNS guard as IPC', async () => {
  const fixture = ipcFixture({ core: 'mihomo' })
  await fixture.directPatch({ core: 'system', systemCorePath: '/source/custom' })
  assert.deepEqual(fixture.events, [
    'import:/source/custom',
    'grant:/managed/local-one/mihomo',
    'dns-prepare',
    'save'
  ])
})

test('cancelling import authorization preserves the current core/config and DNS', async () => {
  const fixture = ipcFixture({ core: 'mihomo', systemCorePath: '/previous/core' }, true)
  const result = (await fixture.patch({ core: 'system', systemCorePath: '/source/custom' })) as {
    invokeError: string
  }
  assert.equal(result.invokeError, '用户取消操作')
  assert.deepEqual(fixture.config, {
    sysProxy: { enable: false },
    core: 'mihomo',
    systemCorePath: '/previous/core'
  })
  assert.deepEqual(fixture.events, ['import:/source/custom', 'grant:/managed/local-one/mihomo'])
})

test('leaving service mode migrates an old external path before granting, and can be cancelled', async () => {
  const fixture = ipcFixture(
    { core: 'system', corePermissionMode: 'service', systemCorePath: '/old/external' },
    true
  )
  await fixture.patch({ corePermissionMode: 'elevated' })
  assert.deepEqual(fixture.events, ['import:/old/external', 'grant:/managed/local-one/mihomo'])
  assert.equal(fixture.config.corePermissionMode, 'service')
  assert.equal(fixture.config.systemCorePath, '/old/external')
})

test('service mode imports without setuid and unrelated patches do not prompt', async () => {
  const fixture = ipcFixture({ core: 'mihomo', corePermissionMode: 'service' })
  await fixture.patch({ core: 'system', systemCorePath: '/source/custom' })
  assert.deepEqual(fixture.events, ['import:/source/custom', 'dns-prepare', 'save'])
  fixture.events.length = 0
  await fixture.patch({ disableEmbedCA: true })
  assert.deepEqual(fixture.events, ['dns-prepare', 'save'])
  const direct = ipcFixture({ core: 'system', systemCorePath: '/managed/local-one/mihomo' })
  await direct.patch({ disableEmbedCA: true })
  assert.deepEqual(direct.events, ['dns-prepare', 'save'])
})

function managerFixture(
  mode: 'log' | 'post-up' | 'service',
  activeTun: boolean,
  requestedTun = true,
  cancelled = false
) {
  const events: string[] = []
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough()
  })
  let postUp!: () => void
  const hookPromise = new Promise<void>((resolve) => {
    postUp = resolve
  })
  const config = {
    core: 'system',
    systemCorePath: '/source/custom',
    coreStartupMode: mode,
    corePermissionMode: mode === 'service' ? 'service' : 'elevated'
  }
  const runtime = { tun: { enable: requestedTun } }
  const noop = (): void => {}
  const dirs = {
    localCoreDir: () => '/managed',
    dataDir: () => '/unused',
    coreLogPath: () => '/unused/log',
    mihomoCorePath: () => config.systemCorePath,
    mihomoWorkDir: () => '/unused/work',
    mihomoIpcPath: () => '/unused/socket'
  }
  const chain = load('./startup-chain.ts', { '../utils/dirs': dirs })
  const mocks: Record<string, unknown> = {
    '../resolve/webhook': { notifyCoreStarted: noop, notifyCoreStopped: noop, emitWebhook: noop },
    child_process: {
      spawn: (file: string) => {
        events.push(`spawn:${file}`)
        return child
      }
    },
    fs: { existsSync: () => false },
    electron: { app: {}, ipcMain: { emit: noop } },
    '../utils/dirs': dirs,
    './local-core': {
      importLocalCore: async () => '/managed/local-one/mihomo',
      ensureLocalCorePermission: async () => {
        events.push('grant')
        if (cancelled) throw new Error('用户取消操作')
      }
    },
    '../config': {
      getAppConfig: async () => config,
      getControledMihomoConfig: async () => runtime,
      getProfileConfig: async () => ({}),
      patchAppConfig: async (patch: object) => Object.assign(config, patch)
    },
    './factory': { generateProfile: async () => {}, getRuntimeConfig: async () => runtime },
    '../custom/profile-builder': { commitProfile: noop, getCommittedProfile: () => undefined },
    '../custom/config-application': {
      prepareCheckedProfile: async () => ({ yaml: '', overrides: [] }),
      attachRunningCore: noop,
      markProfileApplied: noop,
      markProfileStopped: noop
    },
    './profile-check': { checkProfile: async () => {} },
    './startup-chain': chain,
    './startupHook': {
      createCoreStartupHook: async () => ({}),
      createCoreHookWaiter: () => ({ promise: hookPromise, attachProcess: noop })
    },
    './process-control': {
      stopChildProcess: async () => {
        events.push('stop-child')
        child.removeAllListeners()
      }
    },
    './network': { recoverDNS: async () => {} },
    './mihomoApi': {
      getAxios: async () => ({ put: noop }),
      mihomoGroups: async () => ({}),
      mihomoConfig: async () => {
        events.push('check-tun')
        return { tun: { enable: activeTun } }
      },
      startMihomoTraffic: async () => {},
      startMihomoConnections: async () => {},
      startMihomoLogs: async () => {},
      startMihomoMemory: async () => {}
    },
    '../sys/mihomo-system-dns': {
      reconcileMihomoSystemDNSLease: async () => {},
      acquireMihomoSystemDNSLease: async () => {
        events.push('acquire-dns')
      },
      releaseMihomoSystemDNSLease: async () => {
        events.push('release-dns')
      }
    },
    '../resolve/gistApi': { uploadRuntimeConfig: async () => {} },
    '../utils/log': {
      appendAppLog: async () => {},
      setMihomoLogSource: noop,
      createLogWritable: () => new Writable({ write: (_chunk, _encoding, done) => done() })
    },
    '../utils/notification': { showNotification: noop },
    '../service/api': {
      getCoreStatus: async () => ({}),
      stopCore: async () => {
        events.push('stop-service')
      }
    },
    './service-core-runtime': {
      createServiceCoreRuntime: () => ({
        pauseAutoResume: noop,
        resumeAutoResume: noop,
        ensureEventHandler: noop,
        beginStartup: noop,
        endStartup: noop,
        setManaged: noop,
        isManaged: () => mode === 'service',
        clearStreams: noop,
        stopEventHandlers: noop,
        startEventStream: async () => {},
        ensureStreamsStarted: async () => {}
      })
    }
  }
  mocks['../custom/core-lifecycle'] = load('../custom/core-lifecycle.ts', {
    ...mocks,
    './paths': { localCoreDir: dirs.localCoreDir },
    '../core/factory': mocks['./factory'],
    '../core/local-core': mocks['./local-core'],
    '../core/mihomoApi': mocks['./mihomoApi'],
    '../core/startup-chain': chain
  })
  const manager = load<typeof import('./manager')>('./manager.ts', mocks)
  return { ...manager, child, events, runtime, config, postUp }
}

async function flushUntil(condition: () => boolean): Promise<void> {
  for (let index = 0; index < 100 && !condition(); index++) await new Promise(setImmediate)
  assert.equal(condition(), true, 'expected startup event')
}

for (const mode of ['post-up', 'log', 'service'] as const) {
  for (const activeTun of [true, false]) {
    test(`${mode}: TUN ${activeTun ? 'success acquires DNS' : 'failure stops without acquiring DNS or changing settings'}`, async () => {
      const fixture = managerFixture(mode, activeTun)
      const result = fixture
        .startCore()
        .then(async (pending) => {
          fixture.events.push('ready-returned')
          await Promise.all(pending)
          return ''
        })
        .catch((error) => String(error))
      if (mode !== 'service') {
        await flushUntil(() => fixture.events.some((event) => event.startsWith('spawn:')))
        fixture.postUp()
        // Coalesced controller/provider output must not lose the readiness event.
        fixture.child.stdout.write(
          'RESTful API unix listening at: /unused/socket\nStart initial compatible provider default\n'
        )
      }
      const error = await result
      assert.equal(fixture.events.includes('acquire-dns'), activeTun)
      assert.equal(fixture.events.includes('ready-returned'), activeTun)
      assert.equal(fixture.runtime.tun.enable, true)
      if (!activeTun) {
        assert.match(error, /虚拟网卡启动失败/)
        const check = fixture.events.indexOf('check-tun')
        const release = fixture.events.indexOf('release-dns', check)
        const stop = fixture.events.indexOf(
          mode === 'service' ? 'stop-service' : 'stop-child',
          check
        )
        assert.ok(check < release && release < stop)
      } else {
        assert.equal(error, '')
        assert.ok(fixture.events.indexOf('check-tun') < fixture.events.indexOf('acquire-dns'))
      }
      assert.equal(fixture.events.includes('grant'), mode !== 'service')
      fixture.child.stdout.destroy()
      fixture.child.stderr.destroy()
    })
  }
}

test('startup cancellation does not stop the current core or touch DNS', async () => {
  const fixture = managerFixture('post-up', false, true, true)
  await assert.rejects(fixture.startCore(), /用户取消操作/)
  assert.deepEqual(fixture.events, ['grant'])
  assert.equal(fixture.config.systemCorePath, '/source/custom')
})

test('TUN-disabled startup does not require a TUN interface', async () => {
  const fixture = managerFixture('post-up', false, false)
  const result = fixture.startCore().then((pending) => Promise.all(pending))
  await flushUntil(() => fixture.events.some((event) => event.startsWith('spawn:')))
  fixture.postUp()
  await result
  assert.equal(fixture.events.includes('check-tun'), false)
})
