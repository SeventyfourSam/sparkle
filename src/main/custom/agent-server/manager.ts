import { ipcMain } from 'electron'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dataDir } from '../../utils/dirs'
import { appendAppLog } from '../../utils/log'
import { defaultAgentServerOptions, type AgentServerOptions } from '../../../shared/agent-server'
import { AgentServerSupervisor } from './supervisor'

let supervisor: AgentServerSupervisor | undefined
let initialization: Promise<void> | undefined

export function initAgentServer(): Promise<void> {
  return (initialization ??= (async () => {
    const file = join(dataDir(), 'agent-server.json')
    supervisor = new AgentServerSupervisor({
      log: (message) => {
        void appendAppLog(`[AgentServer]: ${message}\n`).catch(() => {})
      },
      save: async (options) => {
        await mkdir(dirname(file), { recursive: true })
        const temporary = `${file}.${randomUUID()}.tmp`
        try {
          await writeFile(temporary, JSON.stringify(options, null, 2) + '\n', {
            mode: 0o600,
            flag: 'wx'
          })
          await rename(temporary, file)
        } finally {
          await rm(temporary, { force: true })
        }
      }
    })
    ipcMain.handle('agentServer:get', () => supervisor!.snapshot())
    ipcMain.handle('agentServer:configure', (_event, options: AgentServerOptions) =>
      supervisor!.configure(options)
    )
    ipcMain.handle('agentServer:restart', () => supervisor!.restart())
    let options = defaultAgentServerOptions()
    try {
      options = { ...options, ...JSON.parse(await readFile(file, 'utf8')) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await supervisor.configure(options, false)
  })())
}

export const stopAgentServer = async (): Promise<void> => {
  await supervisor
    ?.stop()
    .catch((error) => appendAppLog(`[AgentServer]: 停止失败，${error}\n`).catch(() => {}))
}
export const agentServerEnabled = (): boolean => supervisor?.enabled ?? false
