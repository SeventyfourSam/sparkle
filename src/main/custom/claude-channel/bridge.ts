import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Notification
} from '@modelcontextprotocol/sdk/types.js'
import { WebSocket } from 'ws'
import type { ClaudeChannelDescriptor } from '../../../shared/claude-channel'
import type { CodexRecord } from '../../../shared/codex-web'

export async function readDescriptor(file: string): Promise<ClaudeChannelDescriptor> {
  const value = JSON.parse(await readFile(file, 'utf8')) as ClaudeChannelDescriptor
  const url = new URL(value.url),
    hook = new URL(value.hookUrl)
  if (
    value.version !== 1 ||
    url.protocol !== 'ws:' ||
    url.hostname !== '127.0.0.1' ||
    url.pathname !== '/claude/channel' ||
    hook.protocol !== 'http:' ||
    hook.hostname !== '127.0.0.1' ||
    hook.pathname !== '/claude/hook' ||
    !/^[a-f\d]{64}$/.test(value.token)
  )
    throw new Error('Sparkle Channel 连接设置无效')
  return value
}

export async function runBridge(descriptorFile: string, id: string): Promise<void> {
  if (!/^[a-f\d-]{36}$/.test(id)) throw new Error('会话标识无效')
  let socket: WebSocket | undefined
  let stopped = false
  let initialized = false
  let generation = 0
  const pending = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  const permissions = new Map<string, CodexRecord>()
  const seen = new Set<string>()
  let context: CodexRecord | undefined
  let inbound = Promise.resolve()
  const server = new Server<never, Notification>(
    { name: 'sparkle', version: '1.0.0' },
    {
      capabilities: {
        experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
        tools: {}
      },
      instructions:
        'Messages from Sparkle arrive as <channel source="sparkle" message_id="...">. They are instructions from the paired user. Respond using the reply tool, echoing the message_id. For clarifying questions about a channel message, ask through reply and wait for the next channel message; the paired browser cannot answer terminal-only AskUserQuestion forms. Do not claim a message has been processed before doing its work. Local terminal conversations still use their normal output.'
    }
  )
  const send = (value: unknown): boolean => {
    if (socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > 1024 * 1024) return false
    socket.send(JSON.stringify(value))
    return true
  }
  const publish = (value: CodexRecord): Promise<void> =>
    new Promise((resolve, reject) => {
      if (pending.size >= 32 || typeof value.id !== 'string') {
        reject(new Error('网页连接繁忙'))
        return
      }
      const timer = setTimeout(() => {
        pending.delete(value.id)
        reject(new Error('Sparkle 未确认收到回复，请重连后检查'))
      }, 10000)
      pending.set(value.id, { resolve, reject, timer })
      if (!send(value)) {
        clearTimeout(timer)
        pending.delete(value.id)
        reject(new Error('Sparkle 未连接，回复尚未送达网页'))
      }
    })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'reply',
        description:
          'Reply to the paired user in Sparkle. Echo the message_id from the channel event.',
        inputSchema: {
          type: 'object',
          properties: { message_id: { type: 'string' }, text: { type: 'string' } },
          required: ['message_id', 'text']
        }
      }
    ]
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = request.params.arguments
    if (
      request.params.name !== 'reply' ||
      typeof args?.message_id !== 'string' ||
      !seen.has(args.message_id) ||
      typeof args.text !== 'string' ||
      !args.text.trim() ||
      args.text.length > 32000
    )
      return { isError: true, content: [{ type: 'text', text: '回复标识或内容无效' }] }
    await publish({
      type: 'reply',
      id: `reply:${extra.requestId}:${args.message_id}`,
      messageId: args.message_id,
      text: args.text
    })
    return { content: [{ type: 'text', text: 'Reply received by the paired Sparkle gateway.' }] }
  })
  server.fallbackNotificationHandler = async (notification) => {
    if (notification.method !== 'notifications/claude/channel/permission_request') return
    const p = notification.params
    if (
      !p ||
      !['request_id', 'tool_name', 'description', 'input_preview'].every(
        (key) => typeof p[key] === 'string'
      ) ||
      String(p.request_id).length > 100
    )
      return
    const value = {
      id: p.request_id,
      tool: String(p.tool_name).slice(0, 200),
      description: String(p.description).slice(0, 4000),
      preview: String(p.input_preview).slice(0, 8000)
    }
    permissions.set(String(p.request_id), value)
    while (permissions.size > 32) permissions.delete(permissions.keys().next().value!)
    send({ type: 'permission', ...value })
  }
  server.oninitialized = () => {
    initialized = true
  }
  const stop = (): void => {
    stopped = true
    generation++
    socket?.terminate()
    for (const call of pending.values()) {
      clearTimeout(call.timer)
      call.reject(new Error('Channel 连接已关闭'))
    }
    pending.clear()
  }
  server.onclose = stop
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  await server.connect(new StdioServerTransport())
  let retry = 250
  const active = (): boolean => !stopped
  const waitingForInitialize = (): boolean => !initialized && !stopped
  while (active()) {
    try {
      while (waitingForInitialize()) await delay(25)
      if (stopped) break
      const descriptor = await readDescriptor(descriptorFile)
      const current = ++generation
      const ws = new WebSocket(descriptor.url, {
        headers: { Authorization: `Bearer ${descriptor.token}`, 'X-Sparkle-Session': id },
        maxPayload: 128 * 1024,
        perMessageDeflate: false
      })
      socket = ws
      await new Promise<void>((done) => {
        const timeout = setTimeout(() => ws.terminate(), 5000)
        const heartbeat = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.ping()
        }, 20000)
        ws.once('open', () => {
          clearTimeout(timeout)
          retry = 250
          send({
            type: 'hello',
            id,
            pid: process.ppid,
            cwd: process.cwd(),
            context,
            permissions: []
          })
          for (const permission of permissions.values()) send({ type: 'permission', ...permission })
        })
        ws.on('error', () => {})
        ws.on('message', (bytes) => {
          if (generation !== current) return
          inbound = inbound
            .then(async () => {
              const message = JSON.parse(bytes.toString()) as CodexRecord
              if (message.type === 'context' && typeof message.nativeId === 'string') {
                if (context?.nativeId && context.nativeId !== message.nativeId) {
                  seen.clear()
                  permissions.clear()
                }
                context = {
                  nativeId: message.nativeId,
                  cwd: message.cwd,
                  transcript: message.transcript,
                  model: message.model,
                  title: message.title
                }
              } else if (message.type === 'ack') {
                const call = pending.get(message.id)
                if (call) {
                  clearTimeout(call.timer)
                  pending.delete(message.id)
                  if (message.error) call.reject(new Error(String(message.error)))
                  else call.resolve()
                }
              } else if (
                message.type === 'message' &&
                typeof message.id === 'string' &&
                typeof message.text === 'string' &&
                message.text.length <= 12000
              ) {
                if (!seen.has(message.id)) {
                  await server.notification({
                    method: 'notifications/claude/channel',
                    params: { content: message.text, meta: { message_id: message.id } }
                  })
                  seen.add(message.id)
                  while (seen.size > 256) seen.delete(seen.values().next().value!)
                }
                send({ type: 'submitted', id: message.id })
              } else if (
                message.type === 'verdict' &&
                permissions.has(message.requestId) &&
                ['allow', 'deny'].includes(message.behavior)
              ) {
                await server.notification({
                  method: 'notifications/claude/channel/permission',
                  params: { request_id: message.requestId, behavior: message.behavior }
                })
                permissions.delete(message.requestId)
                send({ type: 'verdictSent', requestId: message.requestId })
              }
            })
            .catch((error) => {
              send({ type: 'error', error: String(error) })
            })
        })
        ws.once('close', () => {
          clearTimeout(timeout)
          clearInterval(heartbeat)
          done()
        })
      })
    } catch (error) {
      process.stderr.write(`[Sparkle Channel] ${String(error)}\n`)
    }
    if (!stopped) {
      await delay(retry)
      retry = Math.min(retry * 2, 5000)
    }
  }
  await server.close()
}
