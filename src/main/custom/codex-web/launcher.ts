import { spawn, type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { win32, posix } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { CodexInstance } from '../../../shared/codex-web'

export interface CodexCommand {
  file: string
  args?: string[]
}

export function codexCandidates(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir()
): string[] {
  const windows = platform === 'win32'
  const path = windows ? win32 : posix
  const binary = windows ? 'codex.exe' : 'codex'
  const searchPath = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || ''
  const directories = [
    env.CODEX_INSTALL_DIR,
    windows
      ? path.join(
          env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
          'Programs',
          'CodexCustom',
          'bin'
        )
      : path.join(home, '.local', 'bin'),
    ...searchPath.split(windows ? ';' : ':'),
    ...(!windows ? ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.cargo', 'bin')] : [])
  ]
  return [
    ...new Set(
      directories
        .filter((directory): directory is string => !!directory && path.isAbsolute(directory))
        .map((directory) => path.join(directory, binary))
    )
  ]
}

export async function findCodexCommand(): Promise<CodexCommand> {
  for (const file of codexCandidates()) {
    try {
      if (!(await stat(file)).isFile()) continue
      await access(file, constants.X_OK)
      return { file }
    } catch {
      /* Try the next installed location. */
    }
  }
  throw new Error(
    '未找到 Codex。请先在这台电脑安装支持 Web 接入的自定义 Codex，并确保 codex 可执行文件在 PATH 或默认安装目录中。'
  )
}

export class CodexLauncher {
  private child?: ChildProcess
  private starting?: Promise<string>
  private stopped = false
  private stopping?: Promise<void>

  constructor(
    private readonly options: {
      instances: () => CodexInstance[]
      command?: () => Promise<CodexCommand>
      timeoutMs?: number
      log?: (message: string) => void
    }
  ) {}

  ensure(cwd: string, port: number, preferred?: string): Promise<string> {
    if (this.stopped) return Promise.reject(new Error('Web 服务正在停止'))
    const ready = this.options
      .instances()
      .filter((instance) => instance.ready && instance.connected)
    const existing = ready.find((instance) => instance.id === preferred) || ready[0]
    if (existing) return Promise.resolve(existing.id)
    if (!this.starting) {
      this.starting = this.launch(cwd, port).finally(() => {
        this.starting = undefined
      })
    }
    return this.starting
  }

  private async launch(cwd: string, port: number): Promise<string> {
    const deadline = Date.now() + (this.options.timeoutMs ?? 20000)
    // An already connected server may still be completing initialize; do not start a duplicate.
    while (
      !this.child &&
      this.options.instances().some((instance) => instance.connected && !instance.error)
    ) {
      if (this.stopped) throw new Error('Web 服务正在停止')
      const ready = this.options
        .instances()
        .find((instance) => instance.connected && instance.ready)
      if (ready) return ready.id
      if (Date.now() >= deadline) throw new Error('Codex 初始化超时，请稍后重试')
      await delay(50)
    }
    let child = this.child
    if (!child) {
      const command = await (this.options.command || findCodexCommand)()
      if (this.stopped) throw new Error('Web 服务正在停止')
      const ready = this.options
        .instances()
        .find((instance) => instance.connected && instance.ready)
      if (ready) return ready.id
      child = spawn(
        command.file,
        [...(command.args || []), 'app-server', '-c', `web_server_port=${port}`],
        {
          cwd,
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'ignore', 'pipe']
        }
      )
      this.child = child
      const ownedChild = child
      const onParentExit = (): void => {
        ownedChild.kill('SIGTERM')
      }
      process.once('exit', onParentExit)
      child.once('exit', () => {
        process.off('exit', onParentExit)
        if (this.child === child) this.child = undefined
      })
      child.once('close', () => process.off('exit', onParentExit))
    }
    let failure: Error | undefined
    let stderr = ''
    const failed = (error: Error): void => {
      failure = error
    }
    const output = (bytes: Buffer): void => {
      stderr = (stderr + bytes.toString()).slice(-4000)
    }
    child.on('error', failed)
    child.stdin?.on('error', failed)
    child.stderr?.on('data', output)
    try {
      while (!this.stopped && Date.now() < deadline) {
        if (failure) throw new Error(`无法启动 Codex：${failure.message}`)
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(
            `Codex 启动后退出（${child.exitCode ?? child.signalCode}）。请确认已安装支持 Web 接入的自定义 Codex。`
          )
        }
        const instance = this.options
          .instances()
          .find((instance) => instance.pid === child.pid && instance.connected && instance.ready)
        if (instance) {
          // Keep draining the bounded stderr stream and handling process errors for its lifetime.
          this.options.log?.(`已启动 Codex app-server，PID ${child.pid}`)
          return instance.id
        }
        await delay(50)
      }
      throw new Error(
        this.stopped
          ? 'Web 服务正在停止'
          : 'Codex 接入超时，请确认安装的自定义 Codex 支持 web_server_port，然后重试。'
      )
    } catch (error) {
      if (stderr) this.options.log?.(`Codex 启动诊断：${stderr}`)
      await this.closeChild(child)
      throw error
    }
  }

  stop(): Promise<void> {
    this.stopped = true
    return (this.stopping ??= this.child ? this.closeChild(this.child) : Promise.resolve())
  }

  private async closeChild(child: ChildProcess): Promise<void> {
    if (this.child === child) this.child = undefined
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
    // Closing the private stdio transport asks only our own standalone server to exit.
    child.stdin?.end()
    const wait = async (milliseconds: number): Promise<boolean> => {
      const deadline = Date.now() + milliseconds
      while (child.exitCode === null && child.signalCode === null && Date.now() < deadline)
        await delay(25)
      return child.exitCode !== null || child.signalCode !== null
    }
    if (await wait(1500)) return
    child.kill('SIGTERM')
    if (await wait(1000)) return
    child.kill('SIGKILL')
    await wait(1000)
  }
}
