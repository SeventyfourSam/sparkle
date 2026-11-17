import { useEffect, useRef, useState } from 'react'
import type { CodexRecord } from '../../../../shared/codex-web'
import '@xterm/xterm/css/xterm.css'

export function StartupTerminal({
  sessionId,
  connected,
  command,
  listen
}: {
  sessionId: string
  connected: boolean
  command: (action: string, params?: CodexRecord) => Promise<CodexRecord>
  listen: (callback: (text: string) => void) => () => void
}): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  const confirm = (key: string): void => {
    void command('confirm', { sessionId, key }).catch((error) => setError(error.message))
  }
  const confirmRef = useRef(confirm)
  confirmRef.current = confirm
  useEffect(() => {
    let disposed = false,
      close: (() => void) | undefined
    void (async () => {
      const { Terminal } = await import('@xterm/xterm')
      if (disposed || !container.current) return
      const terminal = new Terminal({
        cols: 90,
        rows: 28,
        fontSize: 12,
        scrollback: 500,
        convertEol: false,
        disableStdin: connected,
        theme: { background: '#111315', foreground: '#edf0ed' }
      })
      terminal.open(container.current)
      let ready = false
      const unlisten = listen((text) => {
        if (ready) terminal.write(text)
      })
      const fit = (): void => {
        if (!container.current) return
        const cols = Math.max(20, Math.min(240, Math.floor(container.current.clientWidth / 7.3)))
        const rows = Math.max(10, Math.min(80, Math.floor(container.current.clientHeight / 14.5)))
        if (terminal.cols === cols && terminal.rows === rows) return
        terminal.resize(cols, rows)
        void command('resize', { sessionId, cols, rows }).catch(() => {})
      }
      let frame = 0
      const observer = new ResizeObserver(() => {
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(fit)
      })
      observer.observe(container.current)
      close = () => {
        unlisten()
        observer.disconnect()
        cancelAnimationFrame(frame)
        terminal.dispose()
        void command('terminal', { sessionId, enabled: false }).catch(() => {})
      }
      const result = await command('terminal', { sessionId, enabled: true })
      if (disposed) return
      terminal.write(result.data || '')
      ready = true
      fit()
      terminal.onData((data) => {
        const key = (
          {
            '\r': 'enter',
            '\x1b': 'escape',
            '\x1b[A': 'up',
            '\x1b[B': 'down',
            '\t': 'tab',
            '\x1b[Z': 'backtab'
          } as Record<string, string>
        )[data]
        if (key) confirmRef.current(key)
      })
    })().catch((error) => {
      if (!disposed) setError(error.message)
    })
    return () => {
      disposed = true
      close?.()
    }
  }, [sessionId, connected, command, listen])
  return (
    <section className="claude-terminal">
      <p>这是官方 Claude Code 的原生启动界面。请阅读提示后选择；账号登录请在电脑上完成。</p>
      <div ref={container} className="claude-terminal-screen" />
      {!connected && (
        <div className="claude-controls">
          {[
            ['up', '↑'],
            ['down', '↓'],
            ['tab', 'Tab'],
            ['escape', 'Esc'],
            ['enter', '确认 ↵']
          ].map(([key, label]) => (
            <button key={key} onClick={() => confirm(key)}>
              {label}
            </button>
          ))}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
