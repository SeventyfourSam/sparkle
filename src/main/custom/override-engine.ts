import { createHash } from 'node:crypto'
import vm from 'node:vm'
import { Worker } from 'node:worker_threads'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { parseYaml } from '../utils/yaml'
import { isMap, parseDocument } from 'yaml'
import { overridePath } from '../utils/dirs'

export function overrideRevision(ext: string, content: string): string {
  return createHash('sha256').update(`${ext}\0${content}`).digest('hex')
}

export function parseOverrideYaml(content: string): Partial<MihomoConfig> {
  const document = parseDocument(content, { merge: true })
  if (document.errors.length) throw document.errors[0]
  if (document.contents !== null && !isMap(document.contents)) {
    throw new Error('YAML 覆写必须是配置对象')
  }
  const value = parseYaml(content)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('YAML 覆写必须是配置对象')
  }
  return value as Partial<MihomoConfig>
}

export function checkOverrideSyntax(ext: string, content: string): void {
  if (ext === 'yaml') parseOverrideYaml(content)
  else new vm.Script(content)
}

// A worker can be terminated even when a script loops synchronously or never
// resolves a promise. Keep the same helpers as upstream's override sandbox.
const workerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const vm = require('node:vm')
const { format } = require('node:util')
const yaml = require(workerData.yamlPath)
const keepAlive = setInterval(() => {}, 1000)
const logs = []
const log = (type, args) => {
  if (logs.length < 200) logs.push('[' + type + '] ' + format(...args).slice(0, 4096))
}
const ctx = vm.createContext({
  console: Object.freeze(Object.fromEntries(['log', 'info', 'error', 'debug'].map(
    type => [type, (...args) => log(type, args)]))),
  fetch,
  yaml: { parse: value => {
    const doc = yaml.parseDocument(value, { merge: true })
    if (doc.errors.length) throw doc.errors[0]
    yaml.visit(doc, { Pair(key, pair, path) {
      if (!yaml.isScalar(pair.key) || pair.key.value !== 'short-id') return
      if (!path.some(node => yaml.isPair(node) && yaml.isScalar(node.key) && node.key.value === 'reality-opts')) return
      const value = pair.value
      if (!yaml.isScalar(value) || value.value === null || typeof value.value === 'string' || value.tag || value.source === undefined) return
      value.value = value.source
      value.tag = 'tag:yaml.org,2002:str'
    } })
    return doc.toJS() || {}
  }, stringify: yaml.stringify },
  b64d: value => Buffer.from(value, 'base64').toString('utf-8'),
  b64e: value => (Buffer.isBuffer(value) ? value : Buffer.from(String(value))).toString('base64'),
  Buffer
})
;(async () => {
  try {
    vm.runInContext(workerData.script, ctx, { timeout: workerData.timeout })
    const result = await vm.runInContext(
      'main(' + JSON.stringify(workerData.profile) + ')', ctx, { timeout: workerData.timeout })
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error('脚本返回值必须是配置对象')
    }
    // Only JSON configuration values may cross the worker boundary.
    const profile = JSON.parse(JSON.stringify(result))
    parentPort.postMessage({ profile, logs })
  } catch (error) {
    parentPort.postMessage({ error: String(error), logs })
  } finally {
    clearInterval(keepAlive)
  }
})()
`

export async function executeOverride(
  profile: MihomoConfig,
  script: string,
  item: OverrideItem,
  timeout = 15_000
): Promise<MihomoConfig> {
  const require = createRequire(__filename)
  const worker = new Worker(workerSource, {
    eval: true,
    workerData: { profile, script, timeout, yamlPath: require.resolve('yaml') }
  })
  let logs: string[] = ['[info] 开始执行脚本']
  try {
    const result = await new Promise<MihomoConfig>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('覆写脚本执行超时')), timeout)
      const cleanup = (): void => clearTimeout(timer)
      worker.once('message', (message) => {
        cleanup()
        logs = logs.concat(message.logs || [])
        if (message.error) reject(new Error(message.error))
        else resolve(message.profile)
      })
      worker.once('error', (error) => {
        cleanup()
        reject(error)
      })
      worker.once('exit', (code) => {
        cleanup()
        reject(new Error(`覆写脚本意外退出：${code}`))
      })
    })
    logs.push('[info] 脚本执行成功')
    return result
  } catch (error) {
    logs.push(`[exception] 脚本执行失败：${error}`)
    throw error
  } finally {
    await worker.terminate()
    await writeFile(overridePath(item.id, 'log'), `${logs.join('\n')}\n`, 'utf8')
  }
}
