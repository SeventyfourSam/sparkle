import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { parse, stringify } from 'yaml'
import { deepMerge } from '../utils/merge'

async function generate(controlled: Partial<MihomoConfig>, rawFallback = true) {
  const raw = {
    'udp-fallback': rawFallback,
    'hook-providers': {
      Confirm: { type: 'api', mode: 'sync', url: 'http://127.0.0.1:1234/ip', 'on-error': 'block' }
    },
    hooks: [{ event: 'IP', match: 'DOMAIN-SUFFIX,example.com', providers: ['Confirm'] }]
  }
  let written = ''
  const mocks = {
    '../config': {
      getAppConfig: async () => ({ controlDns: false, controlSniff: false }),
      getProfileConfig: async () => ({}),
      getProfileStr: async () => stringify(raw),
      getProfileItem: async () => ({}),
      getOverrideConfig: async () => ({}),
      getControledMihomoConfig: async () => controlled
    },
    '../utils/dirs': { mihomoWorkConfigPath: () => 'unused' },
    '../utils/yaml': { parseYaml: parse, stringifyYaml: stringify },
    '../utils/merge': { deepMerge },
    'fs/promises': {
      writeFile: async (_file: string, value: string) => {
        written = value
      }
    }
  }
  const filename = path.join(import.meta.dirname, 'factory.ts')
  const source = ts.transpileModule(readFileSync(filename, 'utf-8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} as typeof import('./factory') }
  runInNewContext(source, {
    module,
    exports: module.exports,
    require: (id: string) => mocks[id] ?? {}
  })
  await module.exports.generateProfile()
  const first = parse(written)
  await module.exports.generateProfile()
  assert.deepEqual(parse(written), first)
  assert.deepEqual(first.hooks, raw.hooks)
  assert.deepEqual(first['hook-providers'], raw['hook-providers'])
  return first
}

test('controlled udp-fallback false survives profile merge, cleanup and regeneration', async () => {
  assert.equal((await generate({ 'udp-fallback': false }))['udp-fallback'], false)
})

test('controlled udp-fallback true overrides profile false', async () => {
  assert.equal((await generate({ 'udp-fallback': true }, false))['udp-fallback'], true)
})

test('an older controlled config preserves a handwritten udp-fallback false', async () => {
  assert.equal((await generate({}, false))['udp-fallback'], false)
})
