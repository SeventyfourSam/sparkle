import { createServer, type Server, type IncomingMessage } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, sep, extname } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { listDirectories, workingDirectory } from './directories'
import { executeWebCommand } from './commands'
import { readModels, modelSettingsParams } from './models'
import { LiveItemCache, recentHistory } from './history'
import { anchoredHistory } from './history-pages'
import { previewItem } from '../../../shared/codex-web-history'
import { serveProjectFile } from './files'
import { threadSettingsPatch, type CodexWebModel } from '../../../shared/codex-web-models'
import { parseCodexWebCommand } from '../../../shared/codex-web-commands'
import {
  CODEX_BROWSER_PATH,
  CODEX_SERVER_PATH,
  type CodexRecord,
  type CodexInstance,
  type CodexPendingRequest
} from '../../../shared/codex-web'

interface Instance extends CodexInstance {
  disconnectedAt?: number
  socket: WebSocket
  calls: Map<
    string,
    { resolve: (value: CodexRecord) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >
  requests: Map<string, CodexPendingRequest>
  subscriptions: Map<string, Promise<unknown>>
  createdThreads: Map<string, { thread: CodexRecord; empty: boolean; generation: number }>
  createdGeneration: number
  threadState: Map<string, CodexRecord>
  rateLimits?: CodexRecord
  modelCatalogs: Map<string, Promise<CodexWebModel[]>>
  liveItems: LiveItemCache
}
interface Browser {
  socket: WebSocket
  queue: Promise<unknown>
  watching?: { instanceId: string; threadId: string }
  itemInterests: Set<string>
}
const supportedRequests = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput'
])
const keyOf = (id: string | number): string => `${typeof id}:${id}`
const loopback = (address = ''): boolean => address === '::1' || /^(::ffff:)?127\./.test(address)
const mime: Record<string, string> = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.html': 'text/html'
}

export class CodexGateway {
  private server?: Server
  private backendServer?: Server
  private stopping?: Promise<void>
  private wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 })
  private instances = new Map<string, Instance>()
  private browsers = new Set<Browser>()
  private sequence = 0
  private previousSnapshot = ''
  private refreshTimer?: NodeJS.Timeout
  private refreshing = false
  private heartbeat?: NodeJS.Timeout

  constructor(
    private readonly options: {
      port: number
      webPort?: number
      host?: string
      frontendDir: string
      version: string
      offlineRetentionMs?: number
      onChange?: () => void
      log?: (text: string) => void
    }
  ) {}

  snapshot(): CodexInstance[] {
    return [...this.instances.values()].map(
      ({ id, pid, runtime, connected, ready, error, connectedAt, threads }) => ({
        id,
        pid,
        runtime,
        connected,
        ready,
        error,
        connectedAt,
        threads
      })
    )
  }

  ports(): { port: number; webPort: number } {
    return {
      port: ((this.backendServer || this.server)?.address() as { port: number }).port,
      webPort: (this.server?.address() as { port: number }).port
    }
  }

  async start(): Promise<number> {
    const root = resolve(this.options.frontendDir)
    const server = createServer(async (req, res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Referrer-Policy', 'no-referrer')
      res.setHeader('Cache-Control', 'no-store')
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405).end()
          return
        }
        const requestUrl = new URL(req.url || '/', 'http://localhost')
        const pathname = requestUrl.pathname
        if (pathname === '/api/file') {
          const instance = this.instances.get(requestUrl.searchParams.get('instanceId') || '')
          const thread = instance?.threads.find(
            (entry) => entry.id === requestUrl.searchParams.get('threadId')
          )
          if (!thread?.cwd) {
            res
              .writeHead(404, { 'Content-Type': 'application/json' })
              .end(JSON.stringify({ error: '会话不存在或未提供工作目录' }))
            return
          }
          await serveProjectFile(req, res, thread.cwd, requestUrl.searchParams)
          return
        }
        if (pathname === '/api/status') {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ports: this.ports(), instances: this.snapshot() }))
          return
        }
        const relative =
          pathname === '/' || pathname === '/codex.html' || pathname === '/codex/file'
            ? 'codex.html'
            : decodeURIComponent(pathname).slice(1)
        const target = resolve(root, relative)
        if (
          !target.startsWith(`${root}${sep}`) ||
          (relative !== 'codex.html' && !relative.startsWith('assets/'))
        ) {
          res.writeHead(404).end()
          return
        }
        const bytes = await readFile(target)
        res.setHeader(
          'Content-Type',
          `${mime[extname(target)] || 'application/octet-stream'}${['.html', '.js', '.css'].includes(extname(target)) ? '; charset=utf-8' : ''}`
        )
        res.end(req.method === 'HEAD' ? undefined : bytes)
      } catch {
        res.writeHead(404).end('页面尚未构建或资源不存在')
      }
    })
    const separate =
      this.options.webPort !== undefined &&
      (this.options.port === 0 || this.options.webPort !== this.options.port)
    const attachUpgrade = (listener: Server, role: 'shared' | 'web' | 'backend'): void => {
      listener.on('upgrade', (req, socket, head) => {
        let pathname: string
        try {
          pathname = new URL(req.url || '/', 'http://localhost').pathname
        } catch {
          socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
          return
        }
        const local = loopback(req.socket.remoteAddress)
        const backend =
          role !== 'web' && pathname === CODEX_SERVER_PATH && local && !req.headers.origin
        const browser =
          role !== 'backend' && pathname === CODEX_BROWSER_PATH && this.sameOrigin(req)
        if (!backend && !browser) {
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
          return
        }
        if (
          backend &&
          (!req.headers['x-codex-instance-id'] ||
            !/^[1-9]\d*$/.test(String(req.headers['x-codex-pid'])) ||
            !['embedded', 'shared', 'standalone'].includes(String(req.headers['x-codex-runtime'])))
        ) {
          socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
          return
        }
        this.wss.handleUpgrade(req, socket, head, (ws) =>
          backend ? this.acceptInstance(ws, req) : this.acceptBrowser(ws)
        )
      })
    }
    this.server = server
    const listen = async (listener: Server, port: number, host: string): Promise<void> => {
      await new Promise<void>((done, reject) => {
        listener.once('error', reject)
        listener.listen(port, host, () => {
          listener.off('error', reject)
          done()
        })
      })
      listener.on('error', (error) => this.options.log?.(`Web 服务错误：${error.message}`))
    }
    try {
      attachUpgrade(server, separate ? 'web' : 'shared')
      if (separate) {
        const backend = createServer((_req, res) => {
          res.writeHead(404).end()
        })
        this.backendServer = backend
        attachUpgrade(backend, 'backend')
        await listen(backend, this.options.port, '127.0.0.1')
      }
      await listen(
        server,
        this.options.webPort ?? this.options.port,
        this.options.host || '0.0.0.0'
      )
    } catch (error) {
      await this.stop()
      throw error
    }
    this.refreshTimer = setInterval(() => void this.refreshAll(), 5000)
    this.heartbeat = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (this.dead.has(ws)) {
          ws.terminate()
          continue
        }
        this.dead.add(ws)
        ws.ping()
      }
    }, 30000)
    return this.ports().port
  }

  private dead = new WeakSet<WebSocket>()
  private sameOrigin(req: IncomingMessage): boolean {
    try {
      return new URL(String(req.headers.origin)).host === req.headers.host
    } catch {
      return false
    }
  }

  stop(): Promise<void> {
    return (this.stopping ??= this.close())
  }

  private async close(): Promise<void> {
    clearInterval(this.refreshTimer)
    clearInterval(this.heartbeat)
    for (const ws of this.wss.clients) ws.terminate()
    for (const instance of this.instances.values()) this.rejectCalls(instance)
    this.instances.clear()
    this.browsers.clear()
    const listeners = [this.server, this.backendServer].filter(
      (listener): listener is Server => !!listener
    )
    this.server = undefined
    this.backendServer = undefined
    await Promise.all(
      listeners.map(async (server) => {
        await new Promise<void>((done) => {
          server.close(() => done())
          server.closeAllConnections()
        })
      })
    )
    await new Promise<void>((done) => {
      this.wss.close(() => done())
    })
  }

  private send(socket: WebSocket, value: unknown): void {
    if (socket.readyState !== WebSocket.OPEN) return
    if (socket.bufferedAmount > 16 * 1024 * 1024) {
      socket.close(1013, '请重新连接以同步消息')
      return
    }
    socket.send(JSON.stringify(value))
  }
  private broadcast(value: unknown): void {
    for (const browser of this.browsers) this.send(browser.socket, value)
  }
  private changed(): void {
    const instances = this.snapshot()
    const fingerprint = JSON.stringify(instances)
    if (fingerprint === this.previousSnapshot) return
    this.previousSnapshot = fingerprint
    this.broadcast({ type: 'instances', instances })
    this.options.onChange?.()
  }
  private rejectCalls(instance: Instance): void {
    for (const call of instance.calls.values()) {
      clearTimeout(call.timer)
      call.reject(new Error('app-server 连接已断开'))
    }
    instance.calls.clear()
  }
  private call(instance: Instance, method: string, params: CodexRecord = {}): Promise<CodexRecord> {
    if (instance.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('app-server 已离线'))
    const id = `sparkle:${++this.sequence}`
    return new Promise((resolveCall, reject) => {
      const timer = setTimeout(() => {
        instance.calls.delete(id)
        reject(new Error(`${method} 响应超时`))
      }, 30000)
      instance.calls.set(id, { resolve: resolveCall, reject, timer })
      this.send(instance.socket, { id, method, params })
    })
  }

  private acceptInstance(socket: WebSocket, req: IncomingMessage): void {
    const id = String(req.headers['x-codex-instance-id'])
    const previous = this.instances.get(id)
    if (previous) {
      this.rejectCalls(previous)
      previous.socket.close(1000, '实例已重新连接')
    }
    const instance: Instance = {
      id,
      pid: Number(req.headers['x-codex-pid']),
      runtime: req.headers['x-codex-runtime'] as Instance['runtime'],
      connected: true,
      ready: false,
      connectedAt: Date.now(),
      threads: [],
      socket,
      calls: new Map(),
      requests: new Map(),
      subscriptions: new Map(),
      createdThreads: new Map(),
      createdGeneration: 0,
      threadState: new Map(),
      modelCatalogs: new Map(),
      liveItems: new LiveItemCache()
    }
    this.instances.set(id, instance)
    this.broadcastRequests(instance)
    socket.on('pong', () => this.dead.delete(socket))
    socket.on('error', () => {})
    socket.on('message', (bytes) => {
      try {
        this.receiveInstance(instance, JSON.parse(bytes.toString()))
      } catch (error) {
        this.options.log?.(`忽略无效 app-server 消息：${error}`)
      }
    })
    socket.on('close', () => {
      this.rejectCalls(instance)
      if (this.instances.get(id) !== instance) return
      instance.connected = false
      instance.ready = false
      instance.disconnectedAt = Date.now()
      instance.requests.clear()
      instance.subscriptions.clear()
      instance.createdThreads.clear()
      this.broadcast({ type: 'requests', instanceId: id, requests: [] })
      this.pruneDisconnected()
      this.changed()
    })
    this.changed()
    void (async () => {
      try {
        await this.call(instance, 'initialize', {
          clientInfo: { name: 'codex-backend', title: 'Sparkle', version: this.options.version },
          capabilities: { experimentalApi: true, requiredHumanApproval: true }
        })
        this.send(socket, { method: 'initialized' })
        instance.ready = true
        await this.refresh(instance)
        for (const browser of this.browsers) {
          if (browser.watching?.instanceId === id)
            void this.watch(browser, id, browser.watching.threadId).catch((error) =>
              this.send(browser.socket, { type: 'error', error: String(error) })
            )
        }
      } catch (error) {
        instance.error = String(error)
        socket.close(1011, '初始化失败')
      } finally {
        if (this.instances.get(id) === instance) this.changed()
      }
    })()
  }

  private receiveInstance(instance: Instance, message: CodexRecord): void {
    if (this.instances.get(instance.id) !== instance) return
    if (!message || typeof message !== 'object') return
    if (!message.method && message.id !== undefined) {
      const pending = instance.calls.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      instance.calls.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message || 'app-server 请求失败'))
      else pending.resolve(message.result || {})
      return
    }
    if (typeof message.method !== 'string') return
    const params: CodexRecord = message.params || {}
    if (typeof params.threadId === 'string') {
      const state = instance.threadState.get(params.threadId) || {}
      if (message.method === 'thread/tokenUsage/updated') state.tokenUsage = params.tokenUsage
      if (message.method === 'thread/goal/updated') state.goal = params.goal
      if (message.method === 'thread/goal/cleared') state.goal = null
      if (message.method === 'thread/goal/updated' || message.method === 'thread/goal/cleared')
        state.goalRevision = (state.goalRevision || 0) + 1
      if (message.method === 'turn/plan/updated') state.plan = params.plan?.slice(0, 100)
      if (message.method === 'turn/diff/updated') {
        state.diff = String(params.diff || '').slice(0, 128000)
        state.diffTruncated = String(params.diff || '').length > 128000
      }
      if (
        message.method === 'thread/settings/updated' &&
        params.threadSettings &&
        typeof params.threadSettings === 'object'
      ) {
        state.settings = { ...state.settings, ...threadSettingsPatch(params.threadSettings) }
        state.settingsRevision = (state.settingsRevision || 0) + 1
        const thread = instance.threads.find((entry) => entry.id === params.threadId)
        if (thread) Object.assign(thread, state.settings)
        const created = instance.createdThreads.get(params.threadId)
        if (created) Object.assign(created.thread, state.settings)
        this.changed()
      }
      if (Object.keys(state).length) instance.threadState.set(params.threadId, state)
    }
    if (message.method === 'account/rateLimits/updated') instance.rateLimits = params
    if (message.id !== undefined) {
      if (!supportedRequests.has(message.method)) {
        // Do not auto-answer device verification or other clients' dynamic tools.
        this.send(instance.socket, {
          id: message.id,
          error: { code: -32601, message: 'Sparkle does not handle this request' }
        })
        return
      }
      const key = keyOf(message.id)
      instance.requests.set(key, {
        key,
        id: message.id,
        instanceId: instance.id,
        method: message.method,
        params
      })
      this.broadcastRequests(instance)
      return
    }
    if (message.method === 'serverRequest/resolved') {
      instance.requests.delete(keyOf(params.requestId))
      this.broadcastRequests(instance)
    }
    if (message.method === 'thread/status/changed') {
      const thread = instance.threads.find((t) => t.id === params.threadId)
      if (thread) {
        thread.status = params.status
        this.changed()
      }
    }
    if (message.method === 'thread/name/updated') {
      const thread = instance.threads.find((t) => t.id === params.threadId)
      if (thread) {
        thread.name = params.threadName ?? params.name
        this.changed()
      }
    }
    if (message.method === 'turn/started') {
      const created = instance.createdThreads.get(params.threadId)
      if (created) created.empty = false
    }
    if (message.method === 'turn/completed') {
      for (const [key, pending] of instance.requests)
        if (
          pending.params.threadId === params.threadId &&
          pending.params.turnId === params.turn?.id
        )
          instance.requests.delete(key)
      this.broadcastRequests(instance)
    }
    const detail =
      params.item || (params.itemId && typeof params.delta === 'string')
        ? instance.liveItems.remember(message.method, params)
        : undefined
    const outputDelta =
      message.method.endsWith('outputDelta') || message.method.endsWith('/outputDelta')
    let browserParams = params
    if (params.item) browserParams = { ...params, item: previewItem(params.item, params.turnId) }
    if (params.turn) browserParams = { ...params, turn: { ...params.turn, items: [] } }
    if (message.method.startsWith('item/reasoning/') && typeof params.delta === 'string')
      browserParams = {
        threadId: params.threadId,
        turnId: params.turnId,
        item: previewItem(
          { id: params.itemId, type: 'reasoning', webHasContent: true },
          params.turnId
        )
      }
    if (message.method === 'turn/diff/updated')
      browserParams = { threadId: params.threadId, diffAvailable: !!params.diff }
    if (message.method === 'turn/plan/updated')
      browserParams = { ...params, plan: params.plan?.slice(0, 100) }
    const supportedEvent = [
      'thread/status/changed',
      'thread/settings/updated',
      'thread/tokenUsage/updated',
      'thread/goal/updated',
      'thread/goal/cleared',
      'turn/started',
      'turn/completed',
      'turn/plan/updated',
      'turn/diff/updated',
      'account/rateLimits/updated',
      'error',
      'item/started',
      'item/completed',
      'item/agentMessage/delta',
      'item/reasoning/summaryTextDelta',
      'item/reasoning/textDelta'
    ].includes(message.method)
    for (const browser of this.browsers) {
      if (
        browser.watching?.instanceId === instance.id &&
        (!params.threadId || browser.watching.threadId === params.threadId)
      ) {
        if (
          detail &&
          browser.itemInterests.has(
            LiveItemCache.key(params.turnId, params.item?.id || params.itemId)
          )
        )
          this.send(browser.socket, {
            type: 'detail',
            instanceId: instance.id,
            threadId: params.threadId,
            ...detail
          })
        if (outputDelta || !supportedEvent) continue
        this.send(browser.socket, {
          type: 'event',
          instanceId: instance.id,
          method: message.method,
          params: browserParams
        })
      }
    }
  }

  private broadcastRequests(instance: Instance): void {
    this.broadcast({
      type: 'requests',
      instanceId: instance.id,
      requests: [...instance.requests.values()]
    })
  }
  private async refresh(instance: Instance): Promise<void> {
    if (!instance.ready) return
    const startedGeneration = instance.createdGeneration
    const ids: string[] = []
    let cursor: string | null = null
    do {
      const result = await this.call(instance, 'thread/loaded/list', { limit: 100, cursor })
      ids.push(...result.data)
      cursor = result.nextCursor || null
    } while (cursor)
    const threads: CodexRecord[] = []
    // Limit concurrency on servers with many loaded subagents.
    for (let start = 0; start < ids.length; start += 8) {
      const revisions = new Map(
        ids
          .slice(start, start + 8)
          .map((id) => [id, instance.threadState.get(id)?.settingsRevision])
      )
      const result = await Promise.allSettled(
        ids
          .slice(start, start + 8)
          .map((threadId) => this.call(instance, 'thread/read', { threadId, includeTurns: false }))
      )
      for (const [index, value] of result.entries()) {
        const id = ids[start + index]
        const created = instance.createdThreads.get(id)
        let thread =
          value.status === 'fulfilled' && value.value.thread
            ? value.value.thread
            : instance.threads.find((item) => item.id === id) || created?.thread
        if (thread) {
          const runtime = instance.threadState.get(id)
          if (value.status === 'fulfilled' && runtime?.settings) {
            if (runtime.settingsRevision !== revisions.get(id))
              thread = { ...thread, ...runtime.settings }
            else
              for (const key of ['model', 'reasoningEffort', 'modelProvider', 'cwd'])
                if (Object.hasOwn(thread, key)) runtime.settings[key] = thread[key]
          }
          threads.push(thread)
          if (created) created.thread = thread
        }
      }
    }
    for (const [id, created] of instance.createdThreads) {
      if (ids.includes(id)) continue
      if (created.generation > startedGeneration) threads.push(created.thread)
      else instance.createdThreads.delete(id)
    }
    instance.threads = threads
    const loaded = new Set(threads.map((thread) => thread.id))
    for (const id of instance.threadState.keys())
      if (!loaded.has(id) && !instance.subscriptions.has(id)) instance.threadState.delete(id)
    instance.error = undefined
  }
  private async refreshAll(): Promise<void> {
    if (this.refreshing) return
    this.refreshing = true
    try {
      await Promise.all(
        [...this.instances.values()]
          .filter((i) => i.ready)
          .map((i) =>
            this.refresh(i).catch((error) => {
              i.error = String(error)
            })
          )
      )
      this.pruneDisconnected()
      this.changed()
    } finally {
      this.refreshing = false
    }
  }

  private pruneDisconnected(): void {
    const unobserved = [...this.instances.values()]
      .filter(
        (instance) =>
          !instance.connected &&
          ![...this.browsers].some((browser) => browser.watching?.instanceId === instance.id)
      )
      .sort((a, b) => (a.disconnectedAt || 0) - (b.disconnectedAt || 0))
    let count = unobserved.length
    for (const instance of unobserved) {
      if (
        count > 32 ||
        Date.now() - (instance.disconnectedAt || 0) >= (this.options.offlineRetentionMs ?? 60000)
      ) {
        this.instances.delete(instance.id)
        count--
      }
    }
  }

  private acceptBrowser(socket: WebSocket): void {
    const browser: Browser = { socket, queue: Promise.resolve(), itemInterests: new Set() }
    this.browsers.add(browser)
    socket.on('pong', () => this.dead.delete(socket))
    socket.on('error', () => {})
    this.send(socket, { type: 'instances', instances: this.snapshot() })
    for (const instance of this.instances.values())
      this.send(socket, {
        type: 'requests',
        instanceId: instance.id,
        requests: [...instance.requests.values()]
      })
    socket.on('message', (bytes) => {
      let message: CodexRecord
      try {
        message = JSON.parse(bytes.toString())
        if (!message || typeof message !== 'object' || Array.isArray(message))
          throw new Error('无效消息')
      } catch {
        this.send(socket, { type: 'error', error: '无效消息' })
        return
      }
      const operation = browser.queue.catch(() => {}).then(() => this.command(browser, message))
      browser.queue = operation
      void operation.then(
        (result) => this.send(socket, { type: 'result', id: message.id, result }),
        (error) =>
          this.send(socket, {
            type: 'result',
            id: message.id,
            error: String(error.message || error)
          })
      )
    })
    socket.on('close', () => {
      this.browsers.delete(browser)
      void this.unwatch(browser)
    })
  }

  private getInstance(id: string): Instance {
    const instance = this.instances.get(id)
    if (!instance?.ready) throw new Error('app-server 尚未连接，请等待重连')
    return instance
  }
  private async unwatch(browser: Browser): Promise<void> {
    browser.itemInterests.clear()
    const old = browser.watching
    browser.watching = undefined
    if (
      !old ||
      [...this.browsers].some(
        (b) => b.watching?.instanceId === old.instanceId && b.watching.threadId === old.threadId
      )
    )
      return
    const instance = this.instances.get(old.instanceId)
    const subscribing = instance?.subscriptions.get(old.threadId)
    // A brand-new thread has no rollout to resume until its first message.
    if (instance?.createdThreads.get(old.threadId)?.empty) return
    if (instance && subscribing) {
      instance.subscriptions.delete(old.threadId)
      await subscribing.catch(() => {})
      if (!instance.subscriptions.has(old.threadId))
        await this.call(instance, 'thread/unsubscribe', { threadId: old.threadId }).catch(() => {})
    }
  }
  private async watch(
    browser: Browser,
    instanceId: string,
    threadId: string
  ): Promise<CodexRecord> {
    if (browser.socket.readyState !== WebSocket.OPEN) throw new Error('网页已断开')
    if (browser.watching?.instanceId !== instanceId || browser.watching.threadId !== threadId)
      await this.unwatch(browser)
    // The browser may reconnect before app-server after a gateway restart.
    browser.watching = { instanceId, threadId }
    const instance = this.getInstance(instanceId)
    if (browser.socket.readyState !== WebSocket.OPEN) throw new Error('网页已断开')
    // Only join this runtime's existing threads, never resume another process's rollout.
    if (!instance.threads.some((t) => t.id === threadId))
      throw new Error('此会话已不在该 app-server 中运行，请刷新列表')
    let subscribing = instance.subscriptions.get(threadId)
    if (!subscribing) {
      const revision = instance.threadState.get(threadId)?.settingsRevision
      subscribing = this.call(instance, 'thread/resume', { threadId, excludeTurns: true }).then(
        (resumed) => {
          const runtime = instance.threadState.get(threadId) || {}
          if (runtime.settingsRevision === revision) {
            const patch: CodexRecord = { ...runtime.settings }
            for (const key of ['model', 'reasoningEffort', 'modelProvider', 'serviceTier', 'cwd']) {
              if (Object.hasOwn(resumed, key)) patch[key] = resumed[key]
              else if (resumed.thread && Object.hasOwn(resumed.thread, key))
                patch[key] = resumed.thread[key]
            }
            runtime.settings = patch
            instance.threadState.set(threadId, runtime)
            const metadata = instance.threads.find((thread) => thread.id === threadId)
            if (metadata) Object.assign(metadata, patch)
          }
          return resumed
        }
      )
      instance.subscriptions.set(threadId, subscribing)
    }
    let subscribed = false
    try {
      const resumed = (await subscribing) as CodexRecord
      subscribed = true
      const history = instance.createdThreads.get(threadId)?.empty
        ? { data: [], nextCursor: null }
        : await recentHistory((method, params) => this.call(instance, method, params), threadId)
      const runtime = instance.threadState.get(threadId)
      const payload = {
        tokenUsage: runtime?.tokenUsage,
        goal: runtime?.goal,
        plan: runtime?.plan,
        diffAvailable: !!runtime?.diff,
        historyNotice: history.historyNotice,
        rateLimits: instance.rateLimits,
        thread: {
          ...resumed.thread,
          model: resumed.model || resumed.thread?.model,
          reasoningEffort: resumed.reasoningEffort || resumed.thread?.reasoningEffort,
          modelProvider: resumed.modelProvider || resumed.thread?.modelProvider,
          serviceTier: resumed.serviceTier,
          approvalPolicy: resumed.approvalPolicy,
          sandbox: resumed.sandbox,
          activePermissionProfile: resumed.activePermissionProfile,
          ...runtime?.settings
        },
        turns: history.data,
        nextCursor: history.nextCursor,
        olderCursor: history.olderCursor,
        newerCursor: history.newerCursor,
        activeTurn: history.activeTurn
      }
      if (browser.watching?.instanceId === instanceId && browser.watching.threadId === threadId)
        this.send(browser.socket, { type: 'history', instanceId, threadId, ...payload })
      // Goals are optional on older app-servers; a missing method must not block chat.
      const goalRevision = instance.threadState.get(threadId)?.goalRevision
      void this.call(instance, 'thread/goal/get', { threadId })
        .then((result) => {
          if (
            result.goal !== undefined &&
            instance.threadState.get(threadId)?.goalRevision === goalRevision
          )
            this.receiveInstance(instance, {
              method: result.goal ? 'thread/goal/updated' : 'thread/goal/cleared',
              params: { threadId, goal: result.goal }
            })
        })
        .catch(() => {})
      return {}
    } catch (error) {
      if (!subscribed && instance.subscriptions.get(threadId) === subscribing)
        instance.subscriptions.delete(threadId)
      throw error
    }
  }

  private async command(browser: Browser, message: CodexRecord): Promise<unknown> {
    if (!message || typeof message !== 'object' || typeof message.id !== 'string')
      throw new Error('无效请求')
    if (message.action === 'refresh') {
      await this.refreshAll()
      return {}
    }
    if (message.action === 'unwatch') {
      await this.unwatch(browser)
      return {}
    }
    if (message.action === 'watch')
      return this.watch(browser, String(message.instanceId), String(message.threadId))
    if (message.action === 'directories')
      return listDirectories(
        message.path,
        [...this.instances.values()].flatMap((item) => item.threads.map((thread) => thread.cwd))
      )
    const instance = this.getInstance(String(message.instanceId))
    if (message.action === 'create') {
      const cwd = await workingDirectory(message.cwd)
      const result = await this.call(instance, 'thread/start', { cwd })
      if (!result.thread || typeof result.thread.id !== 'string')
        throw new Error('Codex 没有返回新会话')
      const thread = {
        ...result.thread,
        cwd: result.thread.cwd || result.cwd || cwd,
        model: result.thread.model || result.model,
        reasoningEffort: result.thread.reasoningEffort || result.reasoningEffort
      }
      if (
        browser.socket.readyState !== WebSocket.OPEN ||
        instance.socket.readyState !== WebSocket.OPEN
      ) {
        await this.call(instance, 'thread/unsubscribe', { threadId: thread.id }).catch(() => {})
        throw new Error('连接已断开，请刷新会话列表')
      }
      // thread/start subscribes this protocol client; reuse that subscription.
      void this.unwatch(browser).catch(() => {})
      browser.watching = { instanceId: instance.id, threadId: thread.id }
      instance.createdThreads.set(thread.id, {
        thread,
        empty: true,
        generation: ++instance.createdGeneration
      })
      instance.subscriptions.set(thread.id, Promise.resolve({ ...result, thread }))
      instance.threads = [...instance.threads.filter((item) => item.id !== thread.id), thread]
      this.changed()
      return { thread }
    }
    if (message.action === 'respond') {
      const pending = instance.requests.get(String(message.key))
      if (!pending || pending.responding) throw new Error('此请求已处理，请等待状态同步')
      const result = this.approvalResult(pending, message)
      pending.responding = true
      this.broadcastRequests(instance)
      this.send(instance.socket, { id: pending.id, result })
      return {}
    }
    if (
      browser.watching?.instanceId !== instance.id ||
      browser.watching.threadId !== message.threadId
    )
      throw new Error('请先打开对应会话')
    const threadId = String(message.threadId)
    if (!instance.subscriptions.has(threadId)) throw new Error('请先重新同步会话')
    if (message.action === 'item' || message.action === 'item/unwatch') {
      if (
        typeof message.turnId !== 'string' ||
        typeof message.itemId !== 'string' ||
        !message.turnId ||
        !message.itemId ||
        message.turnId.length > 200 ||
        message.itemId.length > 300
      )
        throw new Error('条目标识无效')
      const key = LiveItemCache.key(message.turnId, message.itemId)
      if (message.action === 'item/unwatch') {
        browser.itemInterests.delete(key)
        return {}
      }
      if (browser.itemInterests.size >= 20 && !browser.itemInterests.has(key))
        throw new Error('请先收起部分工具详情')
      browser.itemInterests.add(key)
      try {
        return await instance.liveItems.read(
          (method, params) => this.call(instance, method, params),
          threadId,
          message.turnId,
          message.itemId
        )
      } catch (error) {
        browser.itemInterests.delete(key)
        throw error
      }
    }
    if (message.action === 'diff')
      return {
        diff: instance.threadState.get(threadId)?.diff || '',
        truncated: !!instance.threadState.get(threadId)?.diffTruncated
      }
    if (message.action === 'models') return { models: await this.models(instance, threadId, true) }
    if (message.action === 'settings') {
      const params = modelSettingsParams(message, await this.models(instance, threadId))
      const current = {
        ...instance.threads.find((thread) => thread.id === threadId),
        ...instance.threadState.get(threadId)?.settings
      }
      if (
        (message.expectedModel !== undefined && message.expectedModel !== (current.model || '')) ||
        (message.expectedEffort !== undefined &&
          message.expectedEffort !== (current.reasoningEffort ?? null))
      )
        throw new Error('设置已在其他客户端更改，请重新打开模型设置')
      try {
        await this.call(instance, 'thread/settings/update', params)
      } catch (error) {
        if (/method not found|unknown variant|unknown method/i.test(String(error)))
          throw new Error('当前 Codex 版本不支持会话模型设置，请更新 Codex 后重试')
        throw error
      }
      return {}
    }
    if (message.action === 'history')
      return message.before
        ? anchoredHistory(
            (method, params) => this.call(instance, method, params),
            threadId,
            message.before,
            message.end || message.before
          )
        : recentHistory(
            (method, params) => this.call(instance, method, params),
            threadId,
            message.cursor
          )
    if (message.action === 'interrupt')
      return this.call(instance, 'turn/interrupt', { threadId, turnId: String(message.turnId) })
    if (message.action === 'send') {
      const text = String(message.text || '').trim()
      if (!text || text.length > 200000) throw new Error('消息不能为空或超过 200000 字符')
      const parsed = parseCodexWebCommand(text)
      if (parsed) {
        const result = await executeWebCommand(parsed, threadId, message.turnId, (method, params) =>
          this.call(instance, method, params)
        )
        if (parsed.name === 'goal')
          this.receiveInstance(instance, {
            method: result.webCommand.goal ? 'thread/goal/updated' : 'thread/goal/cleared',
            params: { threadId, goal: result.webCommand.goal }
          })
        return result
      }
      const input = [{ type: 'text', text: text.startsWith('//') ? text.slice(1) : text }]
      if (message.turnId)
        return this.call(instance, 'turn/steer', {
          threadId,
          expectedTurnId: String(message.turnId),
          input
        })
      const result = await this.call(instance, 'turn/start', { threadId, input })
      const created = instance.createdThreads.get(threadId)
      if (created) created.empty = false
      if (
        !this.browsers.size ||
        ![...this.browsers].some(
          (item) => item.watching?.instanceId === instance.id && item.watching.threadId === threadId
        )
      ) {
        instance.subscriptions.delete(threadId)
        void this.call(instance, 'thread/unsubscribe', { threadId }).catch(() => {})
      }
      return result
    }
    throw new Error('不支持的操作')
  }

  private models(instance: Instance, threadId: string, refresh = false): Promise<CodexWebModel[]> {
    const provider =
      instance.threadState.get(threadId)?.settings?.modelProvider ||
      instance.threads.find((thread) => thread.id === threadId)?.modelProvider ||
      ''
    let catalog = instance.modelCatalogs.get(provider)
    if (!catalog || refresh) {
      catalog = readModels((method, params) => this.call(instance, method, params), provider)
      instance.modelCatalogs.set(provider, catalog)
      const requested = catalog
      void catalog.catch(() => {
        if (instance.modelCatalogs.get(provider) === requested)
          instance.modelCatalogs.delete(provider)
      })
    }
    return catalog
  }

  private approvalResult(pending: CodexPendingRequest, message: CodexRecord): CodexRecord {
    if (pending.method === 'item/tool/requestUserInput') {
      const answers: CodexRecord = {}
      for (const question of pending.params.questions || []) {
        const answer = message.answers?.[question.id]
        if (typeof answer !== 'string' || !answer.trim()) throw new Error('请回答所有问题')
        answers[question.id] = { answers: [answer] }
      }
      return { answers }
    }
    if (pending.method === 'item/permissions/requestApproval') {
      if (!['accept', 'decline'].includes(message.decision)) throw new Error('无效的审批结果')
      const permissions: CodexRecord = {}
      if (message.decision === 'accept') {
        for (const field of ['network', 'fileSystem'])
          if (pending.params.permissions?.[field])
            permissions[field] = pending.params.permissions[field]
      }
      return { permissions, scope: 'turn' }
    }
    if (!['accept', 'decline', 'cancel'].includes(message.decision))
      throw new Error('无效的审批结果')
    return { decision: message.decision }
  }
}
