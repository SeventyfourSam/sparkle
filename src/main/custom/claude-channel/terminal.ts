import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createInterface } from 'node:readline'
import type { ClaudeChannelDescriptor } from '../../../shared/claude-channel'
import { claudeLaunchConfig, findClaude } from './launch-config'

export interface ClaudeTerminal {
  pid: number
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: () => void
}
export interface TerminalStart {
  id: string
  cwd: string
  resume?: string
  descriptor: ClaudeChannelDescriptor
  descriptorFile: string
  onData: (data: string) => void
  onExit: (code: number) => void
}

export async function startClaudeTerminal(value: TerminalStart): Promise<ClaudeTerminal> {
  const executable = await findClaude()
  // Authentication belongs to the official CLI. Do not offer provider sign-in
  // or forward login credentials through Sparkle's browser/terminal.
  try {
    const { stdout } = await promisify(execFile)(executable, ['auth', 'status', '--json'], {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 128 * 1024
    })
    if (JSON.parse(stdout).loggedIn !== true) throw new Error('not logged in')
  } catch {
    throw new Error('请先在电脑的官方 Claude Code 中完成登录；Sparkle 不提供 Claude 账号登录')
  }
  const config = claudeLaunchConfig(
    value.descriptor,
    value.descriptorFile,
    value.id,
    value.resume ? ['--resume', value.resume] : []
  )
  const env = Object.fromEntries(
    Object.entries(config.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  )
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(value.descriptor.runtime, [value.descriptor.bridge, '--terminal-worker'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true
  })
  const lines = createInterface({ input: child.stdout })
  let finished = false,
    closing = false,
    nativeCode: number | undefined,
    force: NodeJS.Timeout | undefined
  const send = (message: unknown): void => {
    if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`)
  }
  const close = (): void => {
    if (closing) return
    closing = true
    send({ type: 'stop' })
    child.stdin.end()
    force = setTimeout(() => child.kill(), 2000)
    force.unref()
  }
  const parentExit = (): void => {
    child.stdin.end()
  }
  process.once('exit', parentExit)
  child.stdin.on('error', () => {})
  child.stderr.resume()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      close()
      reject(new Error('Claude 原生终端启动超时'))
    }, 10000)
    const done = (code: number): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      clearTimeout(force)
      process.off('exit', parentExit)
      lines.close()
      reject(new Error('Claude 原生终端已退出'))
      value.onExit(code)
    }
    child.once('error', (error) => {
      reject(error)
      done(1)
    })
    child.once('exit', (code) => done(nativeCode ?? code ?? 1))
    lines.on('line', (line) => {
      try {
        const message = JSON.parse(line)
        if (message.type === 'ready') {
          clearTimeout(timer)
          resolve({
            pid: message.pid,
            write: (data) => send({ type: 'write', data }),
            resize: (cols, rows) => send({ type: 'resize', cols, rows }),
            kill: close
          })
        } else if (message.type === 'data') value.onData(message.data)
        else if (message.type === 'exit') {
          nativeCode = message.code
          close()
        } else if (message.type === 'error') {
          reject(new Error(`Claude 原生终端启动失败：${message.error}`))
          close()
        }
      } catch {
        /* Ignore incomplete frames from a closing child. */
      }
    })
    send({ type: 'start', executable, args: config.args, env, cwd: value.cwd })
  })
}
