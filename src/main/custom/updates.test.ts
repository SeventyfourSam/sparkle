import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { parse, stringify } from 'yaml'
import * as repositories from '../../shared/repositories'

function load<T>(relative: string, mocks: Record<string, unknown>, platform = 'win32'): T {
  const file = path.join(import.meta.dirname, relative)
  const output = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText
  const module = { exports: {} }
  runInNewContext(output, {
    module,
    exports: module.exports,
    require: (name: string) => mocks[name] ?? {},
    process: { platform, arch: 'x64' },
    Buffer
  })
  return module.exports as T
}

test('core updates delegate to Mihomo /upgrade using the existing controller connection', async () => {
  for (const platform of ['win32', 'darwin']) {
    const requests: { method: string; url: string; body: unknown }[] = []
    const connection = {
      defaults: { baseURL: 'http://localhost' },
      interceptors: { response: { use: () => {} } },
      post: async (url: string, body: unknown) => requests.push({ method: 'POST', url, body }),
      patch: async (url: string, body: unknown) => requests.push({ method: 'PATCH', url, body })
    }
    const api = load<typeof import('../core/mihomoApi')>(
      '../core/mihomoApi.ts',
      {
        axios: { create: () => connection },
        '../config': { getAppConfig: async () => ({ core: 'mihomo' }) },
        '../utils/dirs': { mihomoIpcPath: () => '/fake/controller' },
        '../sys/mihomo-system-dns': { prepareMihomoSystemDnsRuntimePatch: async () => {} }
      },
      platform
    )
    await api.mihomoUpgrade('release')
    assert.equal(requests.at(-1)?.method, 'POST')
    assert.equal(requests.at(-1)?.url, '/upgrade?channel=release')
    assert.equal(requests.at(-1)?.body, undefined)
    assert.equal(requests.length, platform === 'win32' ? 2 : 1)
  }
})

test('app update checks the fork and compares the complete version, including custom revisions', async () => {
  const requests: string[] = []
  const api = load<typeof import('../resolve/autoUpdater')>('../resolve/autoUpdater.ts', {
    axios: {
      get: async (url: string) => {
        requests.push(url)
        return {
          data: stringify({
            version: '1.26.10-custom.3',
            tag: 'v1.26.10-custom.3',
            changelog: 'New revision'
          })
        }
      }
    },
    electron: { app: { getVersion: () => '1.26.10-custom.2' } },
    '../config': {
      getAppConfig: async () => ({ updateChannel: 'stable' }),
      getControledMihomoConfig: async () => ({ 'mixed-port': 0 })
    },
    '../utils/yaml': { parseYaml: parse },
    '../../shared/repositories': repositories
  })
  assert.equal((await api.checkUpdate())?.version, '1.26.10-custom.3')
  assert.deepEqual(requests, [repositories.SPARKLE_UPDATE_URL])
})

test('app updates download and launch our installer for custom versions', async () => {
  const data = Buffer.from('verified installer fixture')
  const version = '1.26.10-custom.3'
  const requests: string[] = []
  const started: string[] = []
  const api = load<typeof import('../resolve/autoUpdater')>('../resolve/autoUpdater.ts', {
    axios: {
      CancelToken: { source: () => ({ token: 'fake' }) },
      get: async (url: string) => {
        requests.push(url)
        return {
          data: url.startsWith(repositories.SPARKLE_RELEASE_API)
            ? {
                assets: [
                  {
                    name: `sparkle-windows-${version}-x64-setup.exe`,
                    digest: `sha256:${createHash('sha256').update(data).digest('hex')}`,
                    size: data.length
                  }
                ]
              }
            : data
        }
      }
    },
    electron: { app: { getVersion: () => '1.26.10-custom.2' } },
    '../config': {
      getAppConfig: async () => ({}),
      getControledMihomoConfig: async () => ({ 'mixed-port': 0 })
    },
    '../utils/dirs': { dataDir: () => '/fake', isPortable: () => false },
    '../../shared/repositories': repositories,
    '../sys/sysproxy': { triggerSysProxy: async () => {} },
    '../service/fallback': { pauseServiceFallbackForAppUpdate: async () => {} },
    'fs/promises': {
      writeFile: async () => {},
      readFile: async () => data,
      statfs: async () => ({ bavail: 10_000_000, bsize: 4096 })
    },
    fs: { existsSync: () => false },
    crypto: { createHash },
    os: { tmpdir: () => '/fake' },
    path,
    child_process: {
      spawn: (file: string) => {
        started.push(file)
        return { unref: () => {} }
      }
    }
  })
  await api.downloadAndInstallUpdate(version)
  assert.equal(requests[0], `${repositories.SPARKLE_RELEASE_API}/tags/v${version}`)
  assert.equal(
    requests[1],
    `${repositories.SPARKLE_RELEASES}/download/v${version}/sparkle-windows-${version}-x64-setup.exe`
  )
  assert.equal(started.length, 1)
})
