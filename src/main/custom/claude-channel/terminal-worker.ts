import { createInterface } from 'node:readline'
import { createRequire } from 'node:module'
import type { IPty } from 'node-pty'

// Keep native PTY handles outside the desktop process. Some ConPTY versions keep
// worker handles alive after a shell exits; this child has a definite lifetime.
export async function runTerminalWorker(): Promise<void> {
  const load = createRequire(__filename)
  // ConPTY's worker_threads entry must have a real filesystem path. Unpacking
  // alone still leaves __dirname inside app.asar when loaded through its alias.
  const nativeEntry = load.resolve('node-pty').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  const { spawn } = load(nativeEntry) as typeof import('node-pty')
  let pty: IPty | undefined,
    started = false,
    stopping = false
  const send = (value: unknown): void => {
    process.stdout.write(`${JSON.stringify(value)}\n`)
  }
  const release = (): void => {
    const child = pty
    pty = undefined
    try {
      child?.kill()
    } catch {
      /* Already closed. */
    }
  }
  const stop = (): void => {
    if (stopping) return
    stopping = true
    release()
    // Let ConPTY finish draining and release its console before this process exits.
    setTimeout(() => process.exit(0), 250)
  }
  process.once('exit', release)
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  const lines = createInterface({ input: process.stdin })
  lines.once('close', stop)
  for await (const line of lines) {
    try {
      if (line.length > 512000) throw new Error('Terminal frame too large')
      const message = JSON.parse(line)
      if (!started && message.type === 'start') {
        started = true
        pty = spawn(message.executable, message.args, {
          name: 'xterm-256color',
          cwd: message.cwd,
          env: message.env,
          cols: 90,
          rows: 28,
          ...(process.platform === 'win32' ? { useConptyDll: true } : {})
        })
        pty.onData((data) => send({ type: 'data', data: data.slice(-64000) }))
        pty.onExit((event) => {
          send({ type: 'exit', code: event.exitCode })
          stop()
        })
        send({ type: 'ready', pid: pty.pid })
      } else if (
        message.type === 'write' &&
        typeof message.data === 'string' &&
        message.data.length <= 12000
      )
        pty?.write(message.data)
      else if (
        message.type === 'resize' &&
        Number.isInteger(message.cols) &&
        message.cols >= 20 &&
        message.cols <= 240 &&
        Number.isInteger(message.rows) &&
        message.rows >= 10 &&
        message.rows <= 80
      )
        pty?.resize(message.cols, message.rows)
      else if (message.type === 'stop') stop()
    } catch (error) {
      send({ type: 'error', error: error instanceof Error ? error.message : String(error) })
      stop()
    }
  }
}
