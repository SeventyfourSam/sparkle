import { useCallback, useEffect, useRef, useState } from 'react'
import { CODEX_BROWSER_PATH, type CodexRecord } from '../../../../shared/codex-web'

export function useGateway(onMessage: (message: CodexRecord) => void): {
  connected: boolean
  command: (action: string, params?: CodexRecord) => Promise<CodexRecord>
} {
  const [connected, setConnected] = useState(false)
  const handler = useRef(onMessage)
  handler.current = onMessage
  const socket = useRef<WebSocket | null>(null)
  const sequence = useRef(0)
  const calls = useRef(
    new Map<
      string,
      {
        resolve: (value: CodexRecord) => void
        reject: (error: Error) => void
        timer: ReturnType<typeof setTimeout>
      }
    >()
  )
  useEffect(() => {
    let disposed = false
    let retry = 500
    let timer: ReturnType<typeof setTimeout>
    const pending = calls.current
    const connect = (): void => {
      const ws = new WebSocket(
        `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${CODEX_BROWSER_PATH}`
      )
      socket.current = ws
      ws.onopen = () => {
        retry = 500
        setConnected(true)
      }
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data)
          if (message.type === 'result') {
            const call = pending.get(message.id)
            if (call) {
              clearTimeout(call.timer)
              pending.delete(message.id)
              if (message.error) call.reject(new Error(message.error))
              else call.resolve(message.result || {})
            }
          } else handler.current(message)
        } catch {
          /* Ignore frames from a closing connection. */
        }
      }
      ws.onclose = () => {
        if (disposed) return
        setConnected(false)
        for (const call of pending.values()) {
          clearTimeout(call.timer)
          call.reject(new Error('连接已断开，消息未确认发送，请重连后检查'))
        }
        pending.clear()
        timer = setTimeout(connect, retry)
        retry = Math.min(retry * 2, 10000)
      }
      ws.onerror = () => ws.close()
    }
    connect()
    const wake = (): void => {
      if (!disposed && socket.current?.readyState === WebSocket.CLOSED) {
        clearTimeout(timer)
        connect()
      }
    }
    window.addEventListener('online', wake)
    document.addEventListener('visibilitychange', wake)
    return () => {
      disposed = true
      clearTimeout(timer)
      socket.current?.close()
      window.removeEventListener('online', wake)
      document.removeEventListener('visibilitychange', wake)
      for (const call of pending.values()) {
        clearTimeout(call.timer)
        call.reject(new Error('页面已关闭'))
      }
      pending.clear()
    }
  }, [])
  const command = useCallback((action: string, params: CodexRecord = {}): Promise<CodexRecord> => {
    if (socket.current?.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('正在重新连接，请稍候'))
    const id = `web:${++sequence.current}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        calls.current.delete(id)
        reject(new Error('请求超时，请刷新状态后重试'))
      }, 45000)
      calls.current.set(id, { resolve, reject, timer })
      socket.current!.send(JSON.stringify({ id, action, ...params }))
    })
  }, [])
  return { connected, command }
}
