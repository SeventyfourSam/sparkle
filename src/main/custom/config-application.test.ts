import assert from 'node:assert/strict'
import { load } from './test-utils'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  checkAppliedConfig,
  requiresCoreRestart,
  rollbackLaunchPatch,
  withConfigTransaction
} from './config-transaction'
import type { PreparedProfile } from './profile-builder'
import { parseYaml, stringifyYaml } from '../utils/yaml'
import { deepMerge } from '../utils/merge'
import { finalizeCustomProfile } from './profile'

function profile(yaml = 'old', patch: Partial<PreparedProfile> = {}): PreparedProfile {
  return {
    yaml,
    raw: 'base',
    currentYaml: '',
    overrideYaml: '',
    current: 'one',
    config: { tun: { enable: true }, 'mixed-port': 7890 } as MihomoConfig,
    appConfig: { core: 'mihomo' } as AppConfig,
    controlledConfig: {},
    configPath: '/work/config.yaml',
    workDir: '/work',
    overrides: [{ id: 'a', revision: yaml }],
    ...patch
  }
}

function fixture() {
  const events: string[] = []
  let next = profile('new')
  let validationError = false
  let rejectReload = false
  let rejectStart = false
  let rejectCommit = false
  let rejectProbe = false
  let checked = false
  let disk = 'old'
  let controller = 'old'
  const failures: string[] = []
  const api = load<typeof import('./config-application')>('config-application.ts', {
    './profile-builder': {
      prepareProfile: async () => {
        events.push('build')
        return next
      },
      commitProfile: async (value: PreparedProfile) => {
        events.push(`commit:${value.yaml}`)
        if (rejectCommit && value.yaml === 'new') throw new Error('disk full')
        disk = value.yaml
      }
    },
    './profile-check': {
      checkProfile: async () => {
        events.push('check')
        if (validationError) throw new Error('invalid configuration')
        checked = true
      }
    },
    './config-transaction': {
      requiresCoreRestart,
      rollbackLaunchPatch,
      checkAppliedConfig,
      withConfigTransaction
    },
    '../config': { patchAppConfig: async () => events.push('restore-launch-settings') },
    './override-status': {
      markOverridesApplied: () => events.push('active'),
      markOverridesStopped: () => events.push('stopped'),
      setOverridesChecking: () => {},
      reportOverrideError: (id: string) => failures.push(id)
    },
    '../core/mihomoApi': {
      getAxios: async () => ({
        put: async (url: string, data: { payload: string }) => {
          assert.equal(checked, true, 'must validate before touching the controller')
          assert.equal(url, '/configs?force=true')
          events.push(`reload:${data.payload}`)
          controller = data.payload
          if (rejectReload && data.payload === 'new') throw new Error('request timed out')
        }
      }),
      mihomoConfig: async () => {
        if (rejectProbe) throw new Error('controller unavailable')
        return {
          tun: { enable: true },
          'mixed-port': 7890,
          port: 0,
          'socks-port': 0,
          'redir-port': 0,
          'tproxy-port': 0
        }
      }
    },
    '../core/manager': {
      stopCore: async () => {
        assert.equal(checked, true)
        events.push('stop')
      },
      startCore: async (_detached: boolean, value: PreparedProfile) => {
        assert.equal(checked, true)
        events.push(`start:${value.yaml}`)
        if (rejectStart && value.yaml === 'new') throw new Error('TUN creation failed')
        disk = controller = value.yaml
        await api.markProfileApplied(value)
      }
    },
    '../sys/mihomo-system-dns': {
      prepareMihomoSystemDnsRuntimePatch: async () => events.push('dns-prepare'),
      acquireMihomoSystemDNSLease: async () => events.push('dns-acquire'),
      reconcileMihomoSystemDNSLease: async () => events.push('dns-reconcile')
    },
    'node:fs/promises': { readFile: async () => 'old' },
    '../utils/yaml': { parseYaml: () => profile().config }
  })
  return {
    api,
    events,
    failures,
    get disk() {
      return disk
    },
    get controller() {
      return controller
    },
    set next(value: PreparedProfile) {
      next = value
    },
    set validationError(value: boolean) {
      validationError = value
    },
    set rejectReload(value: boolean) {
      rejectReload = value
    },
    set rejectStart(value: boolean) {
      rejectStart = value
    },
    set rejectCommit(value: boolean) {
      rejectCommit = value
    },
    set rejectProbe(value: boolean) {
      rejectProbe = value
    }
  }
}

test('preflight failure preserves the old process, runtime file, DNS and loaded revision', async () => {
  const f = fixture()
  await f.api.markProfileApplied(profile())
  f.events.length = 0
  f.validationError = true
  await assert.rejects(f.api.applyConfiguration(), /invalid configuration/)
  assert.deepEqual(f.events, ['build', 'check'])
  assert.equal(f.disk, 'old')
  assert.equal(f.controller, 'old')
  assert.equal(f.api.getAppliedProfile()?.yaml, 'old')
  assert.deepEqual(f.failures, ['a'])
})

test('a normal edit reloads the exact tested bytes before committing, without stopping', async () => {
  const f = fixture()
  await f.api.markProfileApplied(profile())
  f.events.length = 0
  await f.api.applyConfiguration()
  assert.deepEqual(f.events, [
    'build',
    'check',
    'dns-prepare',
    'reload:new',
    'commit:new',
    'dns-acquire',
    'active'
  ])
  assert.equal(f.disk, 'new')
  assert.equal(f.controller, 'new')
})

test('a timeout after applying, or a disk-write failure, restores the old snapshot without restarting', async () => {
  for (const failure of ['reload', 'commit'] as const) {
    const f = fixture()
    await f.api.markProfileApplied(profile())
    f.events.length = 0
    if (failure === 'reload') f.rejectReload = true
    else f.rejectCommit = true
    await assert.rejects(f.api.applyConfiguration(), /保留上次成功配置/)
    assert.equal(f.disk, 'old')
    assert.equal(f.controller, 'old')
    assert.equal(f.events.includes('stop'), false)
    assert.equal(f.api.getAppliedProfile()?.yaml, 'old')
  }
})

test('controller probe failure never escalates an ordinary edit into a restart', async () => {
  const f = fixture()
  await f.api.markProfileApplied(profile())
  f.rejectProbe = true
  await assert.rejects(f.api.applyConfiguration(), /controller unavailable/)
  assert.equal(f.events.includes('stop'), false)
  assert.equal(
    f.events.some((e) => e.startsWith('reload:')),
    false
  )
})

test('even an unchanged snapshot must probe the running core before reporting it as active', async () => {
  const f = fixture()
  await f.api.markProfileApplied(profile())
  f.next = profile()
  f.rejectProbe = true
  f.events.length = 0
  await assert.rejects(f.api.applyConfiguration(), /controller unavailable/)
  assert.deepEqual(f.events, ['build', 'check'])
})

test('attaching to an existing service loads the tested candidate before replacing its runtime file', async () => {
  const f = fixture()
  const candidate = await f.api.prepareCheckedProfile()
  await f.api.attachRunningCore(candidate)
  assert.deepEqual(f.events, [
    'build',
    'check',
    'dns-prepare',
    'reload:new',
    'commit:new',
    'dns-acquire',
    'active'
  ])
  assert.equal(f.api.getAppliedProfile()?.yaml, 'new')
})

test('forced restart is checked first and a failed start restores the previous tested profile', async () => {
  const f = fixture()
  await f.api.markProfileApplied(profile())
  f.events.length = 0
  f.rejectStart = true
  await assert.rejects(f.api.applyConfiguration(true), /TUN creation failed/)
  assert.deepEqual(f.events, ['build', 'check', 'stop', 'start:new', 'stop', 'start:old', 'active'])
  assert.equal(f.disk, 'old')
})

test('crash recovery uses the previous successful snapshot without executing pending drafts', async () => {
  const f = fixture()
  await f.api.markProfileApplied(profile())
  f.events.length = 0
  await f.api.recoverAppliedConfiguration()
  assert.deepEqual(f.events, ['check', 'stop', 'start:old', 'active'])
})

test('a failed launch-settings change restores those settings before starting the previous core', async () => {
  const f = fixture()
  await f.api.markProfileApplied(profile())
  f.events.length = 0
  f.next = profile('new', { appConfig: { core: 'system' } as AppConfig })
  f.rejectStart = true
  await assert.rejects(f.api.applyConfiguration(), /TUN creation failed/)
  assert.deepEqual(f.events, [
    'build',
    'check',
    'stop',
    'start:new',
    'restore-launch-settings',
    'stop',
    'start:old',
    'active'
  ])
})

test('TUN and rule changes can reload, while launch, working directory and controller changes require restart', () => {
  const before = profile()
  assert.equal(requiresCoreRestart(before, profile('new')), false)
  assert.equal(requiresCoreRestart(before, profile('new', { workDir: '/other' })), true)
  assert.equal(
    requiresCoreRestart(before, profile('new', { appConfig: { core: 'system' } as AppConfig })),
    true
  )
  assert.equal(
    requiresCoreRestart(before, profile('new', { config: { secret: 'new' } as MihomoConfig })),
    true
  )
  assert.throws(
    () => checkAppliedConfig(before.config, { tun: { enable: false } } as ControllerConfigs),
    /TUN/
  )
})

test('configuration operations remain serialized after an earlier operation rejects', async () => {
  const events: number[] = []
  const first = withConfigTransaction(async () => {
    events.push(1)
    throw new Error('bad')
  })
  const second = withConfigTransaction(async () => {
    events.push(2)
  })
  await assert.rejects(first, /bad/)
  await second
  assert.deepEqual(events, [1, 2])
})

test('override workers validate results, preserve YAML helpers, and terminate hanging scripts', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sparkle-override-test-'))
  try {
    const engine = load<typeof import('./override-engine')>('override-engine.ts', {
      '../utils/yaml': { parseYaml },
      '../utils/dirs': { overridePath: () => path.join(dir, 'script.log') }
    })
    const item = { id: 'test', name: 'test', ext: 'js' } as OverrideItem
    const input = { 'udp-fallback': false } as MihomoConfig
    const result = await engine.executeOverride(
      input,
      `async function main(config) {
      config['udp-fallback'] = true
      config.sid = yaml.parse('reality-opts:\\n  short-id: 1234')['reality-opts']['short-id']
      config.roundtrip = b64d(b64e('测试'))
      console.log('validated')
      return config
    }`,
      item
    )
    assert.equal(result['udp-fallback'], true)
    assert.equal(result['sid'], '1234')
    assert.equal(result['roundtrip'], '测试')
    assert.equal(input['udp-fallback'], false)
    assert.match(await readFile(path.join(dir, 'script.log'), 'utf8'), /validated/)
    for (const script of [
      'function main() { throw new Error("broken") }',
      'function main() { return null }',
      'function main() { return [] }',
      'function main() { return "text" }'
    ])
      await assert.rejects(engine.executeOverride(input, script, item), /broken|配置对象/)
    await assert.rejects(
      engine.executeOverride(input, 'function main() { while(true) {} }', item, 150),
      /超时|timed out/
    )
    await assert.rejects(
      engine.executeOverride(input, 'function main() { return new Promise(() => {}) }', item, 150),
      /超时/
    )
    for (const yaml of ['[]', 'false', 'null', 'key: [']) {
      assert.throws(() => engine.checkOverrideSyntax('yaml', yaml))
    }
    assert.doesNotThrow(() => engine.checkOverrideSyntax('yaml', ''))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('status follows the loaded revision, with invalid or unapplied drafts kept separate', async () => {
  let text = 'udp-fallback: true'
  const revision = (content: string): string => content
  const item = { id: 'a', ext: 'yaml' } as OverrideItem
  const statuses = load<typeof import('./override-status')>('override-status.ts', {
    '../config/override': {
      getOverride: async () => text,
      getOverrideConfig: async () => ({ items: [item] })
    },
    './override-engine': {
      overrideRevision: (_ext: string, content: string) => revision(content),
      checkOverrideSyntax: (_ext: string, content: string) => parseYaml(content)
    }
  })
  assert.equal((await statuses.getOverrideStatuses()).a.state, 'inactive')
  statuses.markOverridesApplied([{ id: 'a', revision: text }])
  assert.equal((await statuses.getOverrideStatuses()).a.state, 'active')
  text = 'udp-fallback: false'
  assert.equal((await statuses.getOverrideStatuses()).a.state, 'inactive')
  statuses.reportOverrideError('a', text, 'invalid output')
  assert.equal((await statuses.getOverrideStatuses()).a.state, 'error')
  assert.match((await statuses.getOverrideStatuses()).a.message, /仍运行上次成功版本/)
  text = 'key: ['
  assert.equal((await statuses.getOverrideStatuses()).a.state, 'error')
  text = 'udp-fallback: true'
  statuses.markOverridesStopped()
  assert.equal((await statuses.getOverrideStatuses()).a.state, 'inactive')
})

test('the existing merger can build a strict candidate without writing or publishing runtime config', async () => {
  let writes = 0
  const controls = { 'udp-fallback': true }
  const config = {
    getAppConfig: async () => ({ controlDns: false, controlSniff: false }),
    getProfileConfig: async () => ({ current: 'one' }),
    getProfileItem: async () => ({ override: ['a'] }),
    getProfileStr: async () => stringifyYaml({ 'udp-fallback': true }),
    getControledMihomoConfig: async () => controls,
    getOverrideConfig: async () => ({ items: [{ id: 'a', ext: 'yaml', name: 'a' }] }),
    getOverride: async () => 'udp-fallback: false'
  }
  const factory = load<typeof import('../core/factory')>('../core/factory.ts', {
    '../config': config,
    '../utils/dirs': {
      mihomoWorkDir: () => '/unused',
      mihomoWorkConfigPath: () => '/unused/config.yaml'
    },
    '../utils/yaml': { parseYaml, stringifyYaml },
    '../utils/merge': { deepMerge },
    '../custom/profile': { finalizeCustomProfile },
    'fs/promises': { writeFile: async () => writes++ }
  })
  const builder = load<typeof import('./profile-builder')>('profile-builder.ts', {
    '../config': config,
    '../core/factory': factory,
    '../utils/merge': { deepMerge },
    './override-engine': {
      parseOverrideYaml: parseYaml,
      overrideRevision: () => 'a-revision'
    },
    './override-status': { clearOverrideError: () => {}, reportOverrideError: () => {} },
    './atomic-file': { writeAtomic: async () => writes++ }
  })
  const candidate = await builder.prepareProfile()
  assert.equal(writes, 0)
  assert.equal(await factory.getRuntimeConfigStr(), undefined)
  assert.equal(parseYaml<MihomoConfig>(candidate.overrideYaml)['udp-fallback'], false)
  assert.equal(candidate.config['udp-fallback'], true)
  assert.equal(candidate.overrides[0].revision, 'a-revision')
  await builder.commitProfile(candidate)
  assert.equal(writes, 1)
  assert.equal(await factory.getRuntimeConfigStr(), candidate.yaml)
  assert.equal(controls['udp-fallback'], true)
})

test('controlled settings are not persisted before validation, and application failure restores their source', async () => {
  for (const failure of ['validation', 'application'] as const) {
    const events: string[] = []
    const original = { 'udp-fallback': false, dns: { enable: true, listen: '' } }
    let source = structuredClone(original)
    const actions = load<typeof import('./config-actions')>('config-actions.ts', {
      '../utils/merge': { deepMerge },
      '../utils/template': { defaultControledMihomoConfig: {} },
      '../config': { getAppConfig: async () => ({ controlDns: false, controlSniff: false }) },
      './config-transaction': { withConfigTransaction },
      './override-engine': {},
      './config-application': {
        prepareCheckedProfile: async () => {
          events.push('validate')
          if (failure === 'validation') throw new Error('bad configuration')
          return profile('new')
        },
        applyConfigurationUnlocked: async (
          _force: boolean,
          _candidate: PreparedProfile,
          beforeRollback: () => Promise<void>
        ) => {
          events.push('apply')
          await beforeRollback()
          throw new Error('failed to apply')
        }
      }
    })
    await assert.rejects(
      actions.applyControlledPatch(
        { 'udp-fallback': true },
        async () => source,
        async (next) => {
          events.push('save')
          source = next as typeof source
        }
      )
    )
    assert.deepEqual(source, original)
    assert.equal(events[0], 'validate')
    if (failure === 'validation') assert.deepEqual(events, ['validate'])
    else assert.deepEqual(events, ['validate', 'save', 'apply', 'save', 'save'])
  }
})
