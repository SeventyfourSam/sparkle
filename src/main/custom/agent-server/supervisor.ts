import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import {
  defaultAgentServerOptions,
  validateAgentServerOptions,
  type AgentServerOptions,
  type AgentServerStatus
} from '../../../shared/agent-server'

export class AgentServerSupervisor {
  private options = defaultAgentServerOptions()
  private state: AgentServerStatus['state'] = 'stopped'
  private error?: string
  private child?: ChildProcessWithoutNullStreams
  private queue: Promise<unknown> = Promise.resolve()
  private retry?: NodeJS.Timeout
  private startup?: NodeJS.Timeout
  private stable?: NodeJS.Timeout
  private attempts = 0
  private disposed = false

  constructor(
    private readonly hooks: {
      save?: (options: AgentServerOptions) => Promise<void>
      log?: (message: string) => void
      startupMs?: number
      stopMs?: number
      retryMs?: number
      maxRetries?: number
      launch?: (
        executable: string,
        args: string[],
        env: NodeJS.ProcessEnv
      ) => ChildProcessWithoutNullStreams
    } = {}
  ) {}

  snapshot(): AgentServerStatus {
    return {
      options: { ...this.options },
      state: this.state,
      pid: this.child?.pid,
      error: this.error
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(operation)
    this.queue = next.catch(() => {})
    return next
  }

  configure(
    value: AgentServerOptions,
    persist = true,
    restart = false
  ): Promise<AgentServerStatus> {
    return this.serialize(async () => {
      if (this.disposed) throw new Error('Sparkle 正在退出')
      const next = validateAgentServerOptions(value)
      if (next.enabled) {
        try {
          if (!isAbsolute(next.executable) || /[\u0000\r\n]/.test(next.executable))
            throw new Error('请选择可执行文件的绝对路径')
          if (process.platform === 'win32' && !next.executable.toLowerCase().endsWith('.exe'))
            throw new Error('请选择独立的 AgentServer.exe')
          if (!(await stat(next.executable)).isFile()) throw new Error('AgentServer 路径必须是文件')
          await access(next.executable, constants.X_OK)
        } catch (error) {
          if (!persist) {
            this.options = next
            this.state = 'error'
            this.error = String(error)
          }
          throw error
        }
      }
      if (this.disposed) throw new Error('Sparkle 正在退出')
      // A rejected path or failed save leaves the current child running.
      if (persist) await this.hooks.save?.(next)
      if (this.disposed) throw new Error('Sparkle 正在退出')
      const changed = JSON.stringify(next) !== JSON.stringify(this.options)
      this.options = next
      if (!changed && !restart && this.child) return this.snapshot()
      this.cancelTimers()
      this.attempts = 0
      await this.stopChild()
      this.error = undefined
      this.state = 'stopped'
      if (next.enabled && !this.disposed) this.startChild()
      return this.snapshot()
    })
  }

  restart(): Promise<AgentServerStatus> {
    return this.serialize(async () => {
      if (this.disposed) throw new Error('Sparkle 正在退出')
      this.cancelTimers()
      this.attempts = 0
      await this.stopChild()
      this.error = undefined
      this.state = 'stopped'
      if (!this.disposed && this.options.enabled) this.startChild()
      return this.snapshot()
    })
  }

  private cancelTimers(): void {
    clearTimeout(this.retry)
    clearTimeout(this.startup)
    clearTimeout(this.stable)
    this.retry = this.startup = this.stable = undefined
  }

  private startChild(): void {
    if (this.disposed || !this.options.enabled) return
    const { executable, port, webPort } = this.options
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS
    const args = ['--managed', '--port', String(port), '--web-port', String(webPort)]
    const child = this.hooks.launch
      ? this.hooks.launch(executable, args, env)
      : spawn(executable, args, {
          cwd: dirname(executable),
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env
        })
    this.child = child
    this.state = 'starting'
    this.error = undefined
    let pending = '',
      diagnostic = ''
    child.stdin.on('error', () => {})
    child.stderr.on('data', (bytes: Buffer) => {
      diagnostic = (diagnostic + bytes.toString()).slice(-1500)
    })
    child.stdout.on('data', (bytes: Buffer) => {
      pending = (pending + bytes.toString()).slice(-8192)
      let newline: number
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline).trim()
        pending = pending.slice(newline + 1)
        if (!line.startsWith('AGENT_SERVER_READY ')) continue
        try {
          const value = JSON.parse(line.slice('AGENT_SERVER_READY '.length))
          if (
            this.child !== child ||
            this.state !== 'starting' ||
            value.protocolVersion !== 1 ||
            value.pid !== child.pid ||
            value.port !== port ||
            value.webPort !== webPort
          )
            continue
          clearTimeout(this.startup)
          this.state = 'running'
          this.hooks.log?.(`AgentServer 已启动，PID ${child.pid}，端口 ${port}/${webPort}`)
          this.stable = setTimeout(() => {
            this.attempts = 0
          }, 60000)
          this.stable.unref()
        } catch {
          /* Other stdout lines are not control messages. */
        }
      }
    })
    const failed = (reason: string): void => {
      if (this.child !== child) return
      this.child = undefined
      clearTimeout(this.startup)
      clearTimeout(this.stable)
      this.error = reason
      this.hooks.log?.('AgentServer 进程意外退出')
      this.scheduleRetry()
    }
    child.once('error', (error) => failed(error.message))
    child.once('exit', (code, signal) =>
      failed(diagnostic.trim() || `AgentServer 已退出（${signal || code}）`)
    )
    this.startup = setTimeout(() => {
      if (this.child !== child) return
      void this.serialize(async () => {
        if (this.child !== child || this.state === 'running') return
        await this.stopChild()
        this.error = diagnostic.trim() || 'AgentServer 启动超时；请确认可执行文件支持 --managed'
        this.scheduleRetry()
      })
    }, this.hooks.startupMs ?? 15000)
    this.startup.unref()
  }

  private scheduleRetry(): void {
    if (this.disposed || !this.options.enabled) return
    if (this.attempts >= (this.hooks.maxRetries ?? 4)) {
      this.state = 'error'
      return
    }
    this.state = 'restarting'
    const delay = Math.min(30000, (this.hooks.retryMs ?? 1000) * 2 ** this.attempts++)
    this.retry = setTimeout(() => {
      void this.serialize(async () => {
        if (!this.child && !this.disposed) this.startChild()
      })
    }, delay)
    this.retry.unref()
  }

  private async stopChild(): Promise<void> {
    const child = this.child
    this.child = undefined
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => child.kill(), this.hooks.stopMs ?? 6000)
      const deadline = setTimeout(done, (this.hooks.stopMs ?? 6000) + 2000)
      function done(): void {
        clearTimeout(force)
        clearTimeout(deadline)
        resolve()
      }
      child.once('exit', done)
      child.once('error', done)
      child.stdin.end()
    })
  }

  stop(): Promise<void> {
    this.disposed = true
    this.cancelTimers()
    return this.serialize(async () => {
      await this.stopChild()
      this.state = 'stopped'
    })
  }

  get enabled(): boolean {
    return this.options.enabled && !this.disposed
  }
}
