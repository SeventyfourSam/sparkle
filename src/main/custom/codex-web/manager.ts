import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import {
  CODEX_WEB_CHANNEL,
  type CodexWebOptions,
  type CodexWebStatus
} from '../../../shared/codex-web'
import { dataDir } from '../../utils/dirs'
import { appendAppLog } from '../../utils/log'
import { defaultCodexWebOptions, readOptions, validateOptions, writeJsonAtomically } from './config'
import { CodexGateway } from './gateway'

let options = defaultCodexWebOptions()
let gateway: CodexGateway | undefined
let lastError: string | undefined
let queue: Promise<unknown> = Promise.resolve()

export function keepCodexWebAlive(): boolean {
  return !!gateway
}
function status(): CodexWebStatus {
  return { options, running: !!gateway, error: lastError }
}

function createGateway(value: CodexWebOptions): CodexGateway {
  return new CodexGateway({
    port: value.port,
    webPort: value.webPort,
    frontendDir: join(__dirname, '../renderer'),
    version: app.getVersion(),
    log: (message) => {
      void appendAppLog(`[Codex Web]: ${message}\n`).catch(() => {})
    }
  })
}

async function save(value: CodexWebOptions): Promise<CodexWebStatus> {
  const next = validateOptions(value)
  if (gateway && next.port === options.port && next.webPort === options.webPort) return status()
  const previous = options
  const wasRunning = !!gateway
  await gateway?.stop()
  gateway = undefined
  const replacement = createGateway(next)
  try {
    await replacement.start()
    await writeJsonAtomically(join(dataDir(), 'custom-codex-web.json'), next)
    options = next
    gateway = replacement
    lastError = undefined
    return status()
  } catch (error) {
    await replacement.stop()
    lastError = String(error)
    if (wasRunning) {
      const restored = createGateway(previous)
      try {
        await restored.start()
        gateway = restored
      } catch (restoreError) {
        await restored.stop()
        lastError += `；原端口恢复失败：${restoreError}`
      }
    }
    throw new Error(lastError)
  }
}

export async function initCodexWeb(): Promise<void> {
  const restoring = restoreCodexWeb()
  queue = restoring
  ipcMain.handle(CODEX_WEB_CHANNEL, (_event, action: string, value?: CodexWebOptions) => {
    const task = queue
      .catch(() => {})
      .then(async () => {
        if (action === 'status') return status()
        if (action === 'save' && value && typeof value === 'object') return save(value)
        throw new Error('无效的 Codex Web 操作')
      })
    queue = task
    return task
  })
  app.once('will-quit', () => {
    void gateway?.stop()
  })
  await restoring
}

async function restoreCodexWeb(): Promise<void> {
  try {
    options = await readOptions(join(dataDir(), 'custom-codex-web.json'))
    const candidate = createGateway(options)
    try {
      await candidate.start()
      gateway = candidate
    } catch (error) {
      await candidate.stop()
      throw error
    }
  } catch (error) {
    lastError = String(error)
    await appendAppLog(`[Codex Web]: ${error}\n`)
  }
}
