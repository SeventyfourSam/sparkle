export interface AgentServerOptions {
  enabled: boolean
  executable: string
  port: number
  webPort: number
}

export interface AgentServerStatus {
  options: AgentServerOptions
  state: 'stopped' | 'starting' | 'running' | 'restarting' | 'error'
  pid?: number
  error?: string
}

export const defaultAgentServerOptions = (): AgentServerOptions => ({
  enabled: false,
  executable: '',
  port: 38471,
  webPort: 38472
})

export function validateAgentServerOptions(value: AgentServerOptions): AgentServerOptions {
  if (typeof value?.enabled !== 'boolean' || typeof value.executable !== 'string')
    throw new Error('AgentServer 配置无效')
  if (
    [value.port, value.webPort].some(
      (port) => !Number.isInteger(port) || port < 1024 || port > 65535
    )
  )
    throw new Error('端口必须是 1024–65535 之间的整数')
  if (value.port === value.webPort) throw new Error('接入端口和网页端口不能相同')
  const executable = value.executable.trim()
  if (value.enabled && !executable) throw new Error('请先选择 AgentServer 可执行文件')
  return { enabled: value.enabled, executable, port: value.port, webPort: value.webPort }
}
