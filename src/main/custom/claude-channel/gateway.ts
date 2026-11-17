import { randomUUID } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { basename, isAbsolute, join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import {
  CLAUDE_BRIDGE_PATH,
  CLAUDE_BROWSER_PATH,
  type ClaudeChannelDescriptor,
  type ClaudeChannelSession,
  type ClaudeMessage,
  type ClaudePermission
} from '../../../shared/claude-channel'
import type { CodexRecord } from '../../../shared/codex-web'
import { listDirectories, workingDirectory } from '../codex-web/directories'
import { writeJsonAtomically } from '../codex-web/config'
import { ClaudeAccess, localBrowser, sameOrigin } from './access'
import { claudeHistory, claudeHistoryDetail, replyId } from './history'
import { serveProjectFile } from '../codex-web/files'
import { startClaudeTerminal, type ClaudeTerminal, type TerminalStart } from './terminal'
import { publishDefaultCommand } from './default-command'

const validId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/.test(id)
const controlKeys: Record<string, string> = {
  enter: '\r',
  escape: '\x1b',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  tab: '\t',
  backtab: '\x1b[Z'
}
type Session = ClaudeChannelSession & {
  projectDirectory: string
  socket?: WebSocket
  transcript?: string
  pty?: ClaudeTerminal
  terminalTail: string
  permissions: Map<string, ClaudePermission>
  messages: ClaudeMessage[]
  replies: Set<string>
  deliveries: Map<
    string,
    { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >
  stream?: { id: string; parts: Map<number, string> }
}
interface Browser {
  socket: WebSocket
  selected?: string
  terminal: boolean
  pending: number
}

async function body(req: IncomingMessage, limit = 2 * 1024 * 1024): Promise<CodexRecord> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const bytes of req) {
    size += bytes.length
    if (size > limit) throw new Error('请求内容过大')
    chunks.push(bytes)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString())
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求格式无效')
  return value
}

export class ClaudeChannelGateway {
  private access?: ClaudeAccess
  private descriptor?: ClaudeChannelDescriptor
  private sessions = new Map<string, Session>()
  private browsers = new Set<Browser>()
  private wss = new WebSocketServer({
    noServer: true,
    maxPayload: 128 * 1024,
    perMessageDeflate: false
  })
  private stopped = false
  private changedTimer?: NodeJS.Timeout
  private dirty = new Set<string>()
  private heartbeat?: NodeJS.Timeout
  private dead = new WeakSet<WebSocket>()
  private wrapper = ''

  constructor(
    private readonly options: {
      directory: string
      bridgeFile: string
      runtime?: string
      log?: (message: string) => void
      startTerminal?: (value: TerminalStart) => Promise<ClaudeTerminal>
      defaultCommand?: boolean
    }
  ) {}

  async start(port: number): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
    this.access = await ClaudeAccess.load(this.options.directory)
    this.descriptor = {
      version: 1,
      url: `ws://127.0.0.1:${port}${CLAUDE_BRIDGE_PATH}`,
      hookUrl: `http://127.0.0.1:${port}/claude/hook`,
      token: this.access.bridgeToken,
      runtime: this.options.runtime || process.execPath,
      bridge: this.options.bridgeFile
    }
    await writeJsonAtomically(this.descriptorFile(), this.descriptor)
    const windows = process.platform === 'win32'
    this.wrapper = join(
      this.options.directory,
      windows ? 'sparkle-claude.cmd' : 'sparkle-claude.sh'
    )
    const cmd = (path: string): string => path.replace(/%/g, '%%')
    const sh = (path: string): string => `'${path.replace(/'/g, `'\\''`)}'`
    const script = windows
      ? `@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${cmd(this.descriptor.runtime)}" "${cmd(this.descriptor.bridge)}" --launch --descriptor "${cmd(this.descriptorFile())}" %*\r\nexit /b %errorlevel%\r\n`
      : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${sh(this.descriptor.runtime)} ${sh(this.descriptor.bridge)} --launch --descriptor ${sh(this.descriptorFile())} "$@"\n`
    await writeFile(this.wrapper, script, { mode: 0o700 })
    await chmod(this.wrapper, 0o700)
    if (this.options.defaultCommand)
      await publishDefaultCommand(this.descriptorFile(), this.descriptor).catch((error) =>
        this.options.log?.(`Claude 默认命令未更新：${String(error)}`)
      )
    this.heartbeat = setInterval(() => {
      for (const socket of this.wss.clients) {
        if (this.dead.has(socket)) {
          socket.terminate()
          continue
        }
        this.dead.add(socket)
        socket.ping()
      }
    }, 30000)
  }
  descriptorFile(): string {
    return join(this.options.directory, 'connection.json')
  }

  async http(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url || '/', 'http://localhost')
    if (url.pathname === '/api/file' && url.searchParams.get('provider') === 'claude') {
      const session = this.sessions.get(url.searchParams.get('sessionId') || '')
      const nativeId = url.searchParams.get('nativeId')
      if (req.method !== 'GET' && req.method !== 'HEAD') res.writeHead(405).end()
      else if (!session?.cwd || (nativeId && nativeId !== session.nativeId))
        res
          .writeHead(404, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ error: '会话不存在或已切换' }))
      else await serveProjectFile(req, res, session.projectDirectory, url.searchParams)
      return true
    }
    if (!url.pathname.startsWith('/claude/api/') && url.pathname !== '/claude/hook') return false
    const json = (status: number, value: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(value))
    }
    if (!this.access || this.stopped) {
      json(503, { error: 'Claude Channel 服务尚未就绪' })
      return true
    }
    try {
      if (url.pathname === '/claude/hook') {
        if (req.method !== 'POST' || !this.access.trustedBridge(req)) {
          json(403, { error: '禁止访问' })
          return true
        }
        const id = req.headers['x-sparkle-session']
        if (!validId(id)) throw new Error('会话标识无效')
        this.hook(id, await body(req))
        json(200, {})
      } else if (url.pathname === '/claude/api/access' && req.method === 'GET') {
        json(200, { available: true, ...(localBrowser(req) ? { wrapper: this.wrapper } : {}) })
      } else if (url.pathname === '/claude/api/status' && req.method === 'GET') {
        json(200, { sessions: this.snapshot() })
      } else json(404, { error: '接口不存在' })
    } catch (error) {
      json(400, { error: error instanceof Error ? error.message : String(error) })
    }
    return true
  }

  upgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    role: 'shared' | 'web' | 'backend'
  ): boolean {
    const path = new URL(req.url || '/', 'http://localhost').pathname
    if (path !== CLAUDE_BRIDGE_PATH && path !== CLAUDE_BROWSER_PATH) return false
    const bridge = path === CLAUDE_BRIDGE_PATH && role !== 'web' && this.access?.trustedBridge(req)
    const browser = path === CLAUDE_BROWSER_PATH && role !== 'backend' && sameOrigin(req)
    const id = req.headers['x-sparkle-session']
    if (this.stopped || (!bridge && !browser) || (bridge && !validId(id))) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return true
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => {})
      ws.on('pong', () => this.dead.delete(ws))
      if (bridge) this.acceptBridge(ws, String(id))
      else this.acceptBrowser(ws)
    })
    return true
  }

  snapshot(): ClaudeChannelSession[] {
    return [...this.sessions.values()].map(
      ({ id, nativeId, title, cwd, model, connected, owned, state, createdAt, error, pty }) => ({
        id,
        nativeId,
        title,
        cwd,
        model,
        connected,
        owned,
        terminal: !!pty,
        state,
        createdAt,
        error
      })
    )
  }
  private create(id: string, cwd: string, owned = false): Session {
    if (this.sessions.has(id)) return this.sessions.get(id)!
    for (const session of this.sessions.values())
      if (
        this.sessions.size >= 64 &&
        !session.connected &&
        !session.pty &&
        ![...this.browsers].some((browser) => browser.selected === session.id)
      )
        this.sessions.delete(session.id)
    if (this.sessions.size >= 64) throw new Error('会话数量已达上限，请关闭不用的会话')
    const session: Session = {
      id,
      title: basename(cwd) || 'Claude 会话',
      cwd,
      projectDirectory: cwd,
      connected: false,
      owned,
      terminal: false,
      state: owned ? 'starting' : 'offline',
      createdAt: Date.now(),
      terminalTail: '',
      permissions: new Map(),
      messages: [],
      replies: new Set(),
      deliveries: new Map()
    }
    this.sessions.set(id, session)
    return session
  }
  private send(socket: WebSocket | undefined, value: unknown): boolean {
    if (socket?.readyState !== WebSocket.OPEN) return false
    if (socket.bufferedAmount > 1024 * 1024) {
      socket.close(1013, '请重新连接')
      return false
    }
    socket.send(JSON.stringify(value))
    return true
  }
  private broadcast(value: unknown, id?: string): void {
    for (const browser of this.browsers)
      if (!id || browser.selected === id) this.send(browser.socket, value)
  }
  private changed(id?: string): void {
    if (this.stopped) return
    if (id) this.dirty.add(id)
    if (!this.changedTimer)
      this.changedTimer = setTimeout(() => {
        this.changedTimer = undefined
        this.broadcast({ type: 'sessions', sessions: this.snapshot() })
        for (const key of this.dirty) this.broadcast({ type: 'changed', sessionId: key }, key)
        this.dirty.clear()
      }, 50)
  }
  private append(session: Session, message: ClaudeMessage): void {
    session.messages = [
      ...session.messages.filter((entry) => entry.id !== message.id),
      message
    ].slice(-40)
    while (session.messages.reduce((sum, entry) => sum + entry.text.length, 0) > 128000)
      session.messages.shift()
    this.broadcast({ type: 'message', sessionId: session.id, message }, session.id)
  }
  private failDeliveries(session: Session): void {
    for (const [id, call] of session.deliveries) {
      clearTimeout(call.timer)
      call.reject(new Error('通道连接已断开，未确认发送，请重连后检查'))
      const message = session.messages.find((entry) => entry.id === `send:${id}`)
      if (message) this.append(session, { ...message, state: 'failed' })
    }
    session.deliveries.clear()
  }

  private acceptBridge(socket: WebSocket, id: string): void {
    let session: Session | undefined
    const timeout = setTimeout(() => socket.close(1008, '缺少会话信息'), 5000)
    socket.on('message', (bytes) => {
      try {
        const message = JSON.parse(bytes.toString()) as CodexRecord
        if (message.type === 'hello') {
          if (
            message.id !== id ||
            typeof message.cwd !== 'string' ||
            !isAbsolute(message.cwd) ||
            message.cwd.length > 4096 ||
            !Number.isInteger(message.pid) ||
            message.pid < 1
          )
            throw new Error('会话信息无效')
          clearTimeout(timeout)
          session = this.create(id, message.cwd)
          session.projectDirectory = message.cwd
          if (session.socket === socket) throw new Error('会话已登记')
          if (session.socket) this.failDeliveries(session)
          session.socket?.close(1000, '桥接已重连')
          session.socket = socket
          session.connected = true
          session.error = undefined
          session.state = 'connected'
          if (!session.nativeId && validId(message.context?.nativeId)) {
            this.hook(id, {
              hook_event_name: 'SessionStart',
              session_id: message.context.nativeId,
              cwd: message.context.cwd,
              transcript_path: message.context.transcript,
              model: message.context.model,
              session_title: message.context.title
            })
          }
          this.context(session)
          session.permissions.clear()
          for (const permission of Array.isArray(message.permissions)
            ? message.permissions.slice(0, 32)
            : [])
            this.permission(session, permission)
          this.changed(id)
          return
        }
        if (!session || session.socket !== socket) throw new Error('请先登记会话')
        if (message.type === 'submitted' && validId(message.id)) {
          const call = session.deliveries.get(message.id)
          if (call) {
            clearTimeout(call.timer)
            session.deliveries.delete(message.id)
            call.resolve()
          }
          const entry = session.messages.find((entry) => entry.id === `send:${message.id}`)
          if (entry && entry.state !== 'replied')
            this.append(session, { ...entry, state: 'submitted' })
        } else if (
          message.type === 'reply' &&
          validId(message.messageId) &&
          typeof message.id === 'string' &&
          message.id.length < 300 &&
          typeof message.text === 'string' &&
          message.text.length <= 32000
        ) {
          const call = session.deliveries.get(message.messageId)
          if (call) {
            clearTimeout(call.timer)
            session.deliveries.delete(message.messageId)
            call.resolve()
          }
          const entry = session.messages.find((entry) => entry.id === `send:${message.messageId}`)
          if (entry) this.append(session, { ...entry, state: 'replied' })
          session.replies.add(message.messageId)
          while (session.replies.size > 256)
            session.replies.delete(session.replies.values().next().value!)
          this.append(session, {
            id: replyId(message.messageId, message.text),
            role: 'assistant',
            text: message.text,
            at: Date.now()
          })
          this.send(socket, { type: 'ack', id: message.id })
        } else if (message.type === 'permission') this.permission(session, message)
        else if (message.type === 'verdictSent') {
          session.permissions.delete(message.requestId)
          session.state = session.permissions.size ? 'waiting' : 'working'
          this.broadcast(
            { type: 'permissions', sessionId: id, permissions: [...session.permissions.values()] },
            id
          )
          this.changed()
        } else if (message.type === 'error') {
          session.error = String(message.error || 'Channel 错误').slice(0, 2000)
          this.changed(id)
        }
      } catch (error) {
        this.send(socket, {
          type: 'ack',
          id: (() => {
            try {
              return JSON.parse(bytes.toString()).id
            } catch {
              return undefined
            }
          })(),
          error: error instanceof Error ? error.message : String(error)
        })
      }
    })
    socket.on('close', () => {
      clearTimeout(timeout)
      if (session?.socket === socket) {
        session.connected = false
        session.socket = undefined
        session.permissions.clear()
        this.failDeliveries(session)
        if (session.state !== 'stopped') session.state = 'offline'
        this.changed(id)
      }
    })
  }
  private permission(session: Session, value: CodexRecord): void {
    if (
      typeof value.id !== 'string' ||
      !/^[a-z]{5}$/.test(value.id) ||
      ![value.tool, value.description, value.preview].every(
        (entry) => typeof entry === 'string' && entry.length <= 16000
      )
    )
      return
    session.permissions.set(value.id, {
      id: value.id,
      tool: value.tool,
      description: value.description,
      preview: value.preview,
      state: 'pending'
    })
    while (session.permissions.size > 32)
      session.permissions.delete(session.permissions.keys().next().value!)
    session.state = 'waiting'
    this.broadcast(
      {
        type: 'permissions',
        sessionId: session.id,
        permissions: [...session.permissions.values()]
      },
      session.id
    )
    this.changed()
  }

  private hook(id: string, value: CodexRecord): void {
    if (value.agent_id) return
    if (
      !validId(value.session_id) ||
      typeof value.cwd !== 'string' ||
      !isAbsolute(value.cwd) ||
      value.cwd.length > 4096
    )
      throw new Error('原生会话信息无效')
    const session = this.create(id, value.cwd)
    const previous = `${session.nativeId}:${session.transcript}:${session.model}`
    if (session.nativeId && session.nativeId !== value.session_id) {
      if (value.hook_event_name !== 'SessionStart') return
      this.failDeliveries(session)
      session.messages = []
      session.permissions.clear()
      session.stream = undefined
      this.broadcast({ type: 'reset', sessionId: id }, id)
    }
    session.nativeId = value.session_id
    if (value.hook_event_name === 'SessionStart') {
      session.cwd = value.cwd
      session.title =
        typeof value.session_title === 'string'
          ? value.session_title.slice(0, 200)
          : basename(value.cwd)
      if (typeof value.model === 'string') session.model = value.model.slice(0, 200)
    }
    if (
      typeof value.transcript_path === 'string' &&
      value.transcript_path.length < 4096 &&
      isAbsolute(value.transcript_path) &&
      value.transcript_path.endsWith('.jsonl')
    )
      session.transcript = value.transcript_path
    if (
      value.hook_event_name === 'MessageDisplay' &&
      typeof value.message_id === 'string' &&
      Number.isInteger(value.index) &&
      value.index >= 0 &&
      value.index < 10000 &&
      typeof value.delta === 'string'
    ) {
      if (session.stream?.id !== value.message_id)
        session.stream = { id: value.message_id, parts: new Map() }
      session.stream.parts.set(value.index, value.delta.slice(0, 12000))
      while (
        session.stream.parts.size > 40 ||
        [...session.stream.parts.values()].reduce((sum, part) => sum + part.length, 0) > 32000
      )
        session.stream.parts.delete(Math.min(...session.stream.parts.keys()))
      const text = [...session.stream.parts]
        .sort((a, b) => a[0] - b[0])
        .map((entry) => entry[1])
        .join('')
        .slice(-12000)
      session.state = 'working'
      this.broadcast({ type: 'stream', sessionId: id, text }, id)
    } else if (
      ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(
        value.hook_event_name
      )
    )
      session.state = 'working'
    else if (['Stop', 'StopFailure'].includes(value.hook_event_name)) {
      session.stream = undefined
      session.state = session.connected ? 'connected' : 'offline'
      if (value.hook_event_name === 'StopFailure')
        session.error = String(value.error_details || value.error || 'Claude 请求失败').slice(
          0,
          2000
        )
      this.broadcast({ type: 'stream', sessionId: id, text: '' }, id)
    } else if (value.hook_event_name === 'SessionEnd') {
      session.state = 'offline'
      session.stream = undefined
    } else if (value.hook_event_name === 'PostModelSwitch' && typeof value.to_model === 'string')
      session.model = value.to_model.slice(0, 200)
    if (
      value.hook_event_name === 'SessionStart' ||
      previous !== `${session.nativeId}:${session.transcript}:${session.model}`
    )
      this.context(session)
    this.changed(id)
  }

  private context(session: Session): void {
    if (session.nativeId)
      this.send(session.socket, {
        type: 'context',
        nativeId: session.nativeId,
        cwd: session.cwd,
        transcript: session.transcript,
        model: session.model,
        title: session.title
      })
  }

  private acceptBrowser(socket: WebSocket): void {
    const browser: Browser = { socket, terminal: false, pending: 0 }
    this.browsers.add(browser)
    this.send(socket, { type: 'sessions', sessions: this.snapshot() })
    socket.on('close', () => this.browsers.delete(browser))
    socket.on('message', (bytes) => {
      let message: CodexRecord
      try {
        message = JSON.parse(bytes.toString())
        if (
          !message ||
          typeof message.id !== 'string' ||
          message.id.length > 100 ||
          typeof message.action !== 'string' ||
          browser.pending >= 16
        )
          throw new Error()
      } catch {
        this.send(socket, { type: 'error', error: '请求无效或过于频繁' })
        return
      }
      browser.pending++
      void this.command(browser, message)
        .then(
          (result) => this.send(socket, { type: 'result', id: message.id, result }),
          (error) =>
            this.send(socket, {
              type: 'result',
              id: message.id,
              error: String(error.message || error)
            })
        )
        .finally(() => {
          browser.pending--
        })
    })
  }

  private async command(browser: Browser, message: CodexRecord): Promise<unknown> {
    if (this.stopped) throw new Error('服务正在停止')
    if (message.action === 'directories') return listDirectories(message.path)
    if (message.action === 'unwatch') {
      browser.selected = undefined
      browser.terminal = false
      return {}
    }
    if (message.action === 'create') {
      const cwd = await workingDirectory(message.cwd)
      if (message.resume !== undefined && !validId(message.resume))
        throw new Error('请填写完整的 Claude 会话 ID')
      if (
        [...this.sessions.values()].filter(
          (session) => session.owned && (session.pty || session.state === 'starting')
        ).length >= 8
      )
        throw new Error('最多同时启动 8 个 Claude 会话')
      const id = randomUUID(),
        session = this.create(id, cwd, true)
      browser.selected = id
      this.changed()
      try {
        let exited = false
        const pty = await (this.options.startTerminal || startClaudeTerminal)({
          id,
          cwd,
          resume: message.resume,
          descriptor: this.descriptor!,
          descriptorFile: this.descriptorFile(),
          onData: (data) => {
            session.terminalTail = (session.terminalTail + data).slice(-64000)
            for (const client of this.browsers)
              if (client.selected === id && client.terminal)
                this.send(client.socket, {
                  type: 'terminal',
                  sessionId: id,
                  data: data.slice(-64000)
                })
          },
          onExit: (code) => {
            exited = true
            session.pty = undefined
            session.state = 'stopped'
            session.connected = false
            session.socket?.close()
            this.failDeliveries(session)
            if (code) session.error = `Claude 已退出（${code}），可查看终端输出`
            this.changed(id)
          }
        })
        if (this.stopped) {
          pty.kill()
          throw new Error('服务正在停止')
        }
        if (!exited) session.pty = pty
        this.changed()
        return { sessionId: id }
      } catch (error) {
        session.state = 'stopped'
        session.error = String(error instanceof Error ? error.message : error)
        this.changed()
        throw error
      }
    }
    const session = this.sessions.get(String(message.sessionId))
    if (!session) throw new Error('会话不存在')
    if (message.action === 'watch') {
      browser.selected = session.id
      browser.terminal = false
      return {
        session: this.snapshot().find((entry) => entry.id === session.id),
        permissions: [...session.permissions.values()],
        messages: session.messages,
        stream: session.stream
          ? [...session.stream.parts]
              .sort((a, b) => a[0] - b[0])
              .map((entry) => entry[1])
              .join('')
              .slice(-12000)
          : ''
      }
    }
    if (browser.selected !== session.id) throw new Error('请先打开对应会话')
    if (message.action === 'history')
      return {
        ...(await claudeHistory(session.transcript, message)),
        ...(message.before || message.after ? {} : { recent: session.messages })
      }
    if (message.action === 'historyDetail')
      return claudeHistoryDetail(session.transcript, message.source)
    if (message.action === 'terminal') {
      browser.terminal = !!message.enabled
      return { data: browser.terminal ? session.terminalTail : '' }
    }
    if (message.action === 'resize') {
      if (
        session.pty &&
        Number.isInteger(message.cols) &&
        message.cols >= 20 &&
        message.cols <= 240 &&
        Number.isInteger(message.rows) &&
        message.rows >= 10 &&
        message.rows <= 80
      )
        session.pty.resize(message.cols, message.rows)
      return {}
    }
    if (message.action === 'confirm') {
      if (session.connected || !session.pty || !Object.hasOwn(controlKeys, message.key))
        throw new Error('仅在启动确认期间接受原生选择按键')
      session.pty.write(controlKeys[message.key])
      return {}
    }
    if (message.action === 'interrupt') {
      if (!session.pty || session.state !== 'working')
        throw new Error('当前会话无法通过网页中断，请在原终端操作')
      session.pty.write('\x1b')
      return {}
    }
    if (message.action === 'stop') {
      if (!session.pty) throw new Error('仅能停止 Sparkle 启动的会话')
      session.pty.kill()
      return {}
    }
    if (message.nativeId !== session.nativeId) throw new Error('原终端已切换会话，请重新打开后操作')
    if (message.action === 'send') {
      if (!session.connected || !session.nativeId)
        throw new Error('Channel 或原生会话信息尚未就绪，请完成终端确认')
      if (
        typeof message.text !== 'string' ||
        !message.text.trim() ||
        message.text.length > 12000 ||
        !validId(message.messageId)
      )
        throw new Error('消息为空或过长')
      if (session.deliveries.size >= 8) throw new Error('正在等待消息确认，请稍后再发送')
      const prior = session.messages.find((entry) => entry.id === `send:${message.messageId}`)
      if (prior) {
        if (prior.state === 'failed') throw new Error('此前发送结果不确定，请先检查会话')
        return { message: prior }
      }
      const entry: ClaudeMessage = {
        id: `send:${message.messageId}`,
        role: 'user',
        text: message.text.trim(),
        at: Date.now(),
        state: 'sending'
      }
      this.append(session, entry)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          session.deliveries.delete(message.messageId)
          this.append(session, { ...entry, state: 'failed' })
          reject(new Error('未确认消息送达通道，请检查终端；不会自动重复发送'))
        }, 10000)
        session.deliveries.set(message.messageId, { resolve, reject, timer })
        if (
          !this.send(session.socket, { type: 'message', id: message.messageId, text: entry.text })
        ) {
          clearTimeout(timer)
          session.deliveries.delete(message.messageId)
          this.append(session, { ...entry, state: 'failed' })
          reject(new Error('通道已断开，未发送消息'))
        }
      })
      return { message: session.messages.find((value) => value.id === entry.id) || entry }
    }
    if (message.action === 'verdict') {
      const permission = session.permissions.get(message.requestId)
      if (
        !session.connected ||
        !permission ||
        permission.state !== 'pending' ||
        !['allow', 'deny'].includes(message.behavior)
      )
        throw new Error('审批已处理或通道离线，请重新同步')
      permission.state = 'submitted'
      if (
        !this.send(session.socket, {
          type: 'verdict',
          requestId: permission.id,
          behavior: message.behavior
        })
      ) {
        permission.state = 'pending'
        throw new Error('审批答复未送出')
      }
      this.broadcast(
        {
          type: 'permissions',
          sessionId: session.id,
          permissions: [...session.permissions.values()]
        },
        session.id
      )
      return {}
    }
    throw new Error('当前 Channel 不支持这项操作')
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    clearInterval(this.heartbeat)
    clearTimeout(this.changedTimer)
    for (const session of this.sessions.values()) {
      this.failDeliveries(session)
      try {
        session.pty?.kill()
      } catch {
        /* Child already exited. */
      }
    }
    for (const socket of this.wss.clients) socket.terminate()
    this.browsers.clear()
    this.sessions.clear()
    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve())
    })
  }
}
