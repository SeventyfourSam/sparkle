/** Declaration merging keeps custom Mihomo fields out of the upstream type files. */
interface AppConfig {
  customMihomo?: { path: string; version: string }
}

interface ControllerConfigs {
  'udp-fallback'?: boolean
}

interface MihomoConfig {
  'udp-fallback'?: boolean
  'hook-providers'?: Record<string, MihomoHookProvider>
  hooks?: { event: 'HOST' | 'IP'; match: string; providers: string[] }[]
}

interface MihomoHookProvider {
  type: 'api' | 'script'
  mode?: 'sync' | 'async'
  timeout?: string
  'on-error'?: 'block' | 'continue'
  'confirmation-ttl'?: string
  url?: string
  headers?: Record<string, string>
  'success-status'?: number
  command?: string
  args?: string[]
}
