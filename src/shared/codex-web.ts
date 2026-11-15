// The app-server protocol evolves independently; retain unknown fields at the boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CodexRecord = Record<string, any>

export const CODEX_SERVER_PORT = 38471
export const CODEX_WEB_PORT = 38472
export const CODEX_SERVER_PATH = '/codex/app-server'
export const CODEX_BROWSER_PATH = '/codex/browser'
export const CODEX_WEB_CHANNEL = 'custom:codex-web'

export interface CodexWebOptions {
  port: number
  webPort: number
}

export interface CodexDirectoryListing {
  path: string
  parent: string | null
  home: string
  roots: string[]
  entries: { name: string; path: string }[]
  truncated: boolean
}

export interface CodexSavedSession {
  id: string
  name: string
  preview: string
  cwd: string
  updatedAt: number
  runningInstanceId?: string
}

export interface CodexSessionPage {
  data: CodexSavedSession[]
  nextCursor: string | null
}

export interface CodexInstance {
  id: string
  pid: number
  runtime: 'embedded' | 'shared' | 'standalone'
  connected: boolean
  ready: boolean
  error?: string
  connectedAt: number
  threads: CodexRecord[]
}

export interface CodexPendingRequest {
  key: string
  id: string | number
  instanceId: string
  method: string
  params: CodexRecord
  responding?: boolean
}

export interface CodexWebStatus {
  options: CodexWebOptions
  running: boolean
  error?: string
}
