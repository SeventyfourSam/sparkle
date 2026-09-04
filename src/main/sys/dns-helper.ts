import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createConnection } from 'node:net'
import { dataDir } from '../utils/dirs'
import { dnsHelperPath, execWithElevationOutput } from './dns-helper-execution'
import {
  buildDnsHelperInstallArgs,
  type DnsHelperAuthMaterial,
  dnsHelperProtocolVersion,
  needsDnsHelperInstall,
  parseDnsLeaseTarget,
  type DnsHelperStatus
} from './dns-helper-protocol'
import { ensureDnsHelperAuthFile } from './dns-helper-auth'

export type { DnsHelperStatus, DnsLeaseTarget } from './dns-helper-protocol'
export { parseDnsLeaseTarget } from './dns-helper-protocol'

const helperSocketPath = '/var/run/sparkle-dns-helper.sock'
const helperAuthFileName = 'dns-helper-auth'
// Target changes can include a pre-probe, old-service restore, new-service
// transaction, and post-probe. Keep conservative headroom so a live root
// transaction cannot outlast the client timeout and appear misleadingly dead.
const helperRequestTimeout = 20000

let acquireInFlight: Promise<DnsHelperStatus> | undefined
let releaseInFlight: Promise<DnsHelperStatus> | undefined
let installInFlight: Promise<DnsHelperStatus> | undefined

export function isMihomoDnsHelperAvailable(): boolean {
  if (process.platform !== 'darwin' || !existsSync(dnsHelperPath())) return false
  try {
    accessSync(dnsHelperPath(), constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** A stale socket indicates an installed/restarting daemon worth repairing. */
export function isMihomoDnsHelperSocketPresent(): boolean {
  return process.platform === 'darwin' && existsSync(helperSocketPath)
}

function unsupportedStatus(error?: string): DnsHelperStatus {
  return { supported: false, active: false, healthy: false, error }
}

function unavailableError(): Error {
  return new Error(
    'Sparkle macOS DNS helper daemon 未安装或不可用；不会回退到 networksetup/scutil，请重新启用或安装 macOS 应用'
  )
}

function helperAuthPath(): string {
  return path.join(dataDir(), helperAuthFileName)
}

function parseHelperOutput(output: string): DnsHelperStatus {
  const lines = output
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      const value = JSON.parse(lines[index]) as DnsHelperStatus
      if (value && typeof value === 'object' && typeof value.supported === 'boolean') {
        return value
      }
    } catch {
      // osascript can add a harmless diagnostic line; keep looking for JSON.
    }
  }
  throw new Error('Sparkle macOS DNS helper 返回了无法识别的状态')
}

async function ensureAuthFile(): Promise<DnsHelperAuthMaterial> {
  return ensureDnsHelperAuthFile(helperAuthPath())
}

async function packagedHelperBuildId(): Promise<string> {
  const data = await readFile(dnsHelperPath())
  return createHash('sha256').update(data).digest('hex')
}

async function readAuthFile(): Promise<string> {
  const token = (await readFile(helperAuthPath(), 'utf8')).trim()
  if (!/^[0-9a-f]{64}$/i.test(token)) throw new Error('macOS DNS helper 认证状态无效')
  return token
}

async function requestDaemon(
  command: 'acquire' | 'release' | 'status' | 'reconcile',
  listen?: string
): Promise<DnsHelperStatus> {
  const auth = await readAuthFile()
  const payload = JSON.stringify({ auth, command, listen }) + '\n'

  return new Promise((resolve, reject) => {
    let settled = false
    let response = ''
    const socket = createConnection(helperSocketPath)
    const finish = (error?: Error, status?: DnsHelperStatus) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else if (status) resolve(status)
      else reject(new Error('macOS DNS helper 返回空响应'))
    }

    socket.setEncoding('utf8')
    socket.setTimeout(helperRequestTimeout, () => finish(new Error('macOS DNS helper 响应超时')))
    socket.once('connect', () => socket.write(payload))
    socket.on('data', (chunk: string) => {
      response += chunk
      const newline = response.indexOf('\n')
      if (newline < 0) return
      try {
        const status = JSON.parse(response.slice(0, newline)) as DnsHelperStatus
        if (!status || typeof status.supported !== 'boolean') {
          finish(new Error('macOS DNS helper 返回了无法识别的状态'))
          return
        }
        finish(undefined, status)
      } catch {
        finish(new Error('macOS DNS helper 返回了无效 JSON'))
      }
    })
    socket.once('error', (error) => finish(error))
    socket.once('close', () => {
      if (!settled) finish(new Error('macOS DNS helper daemon 连接已关闭'))
    })
  })
}

async function daemonStatus(): Promise<DnsHelperStatus | undefined> {
  try {
    return await requestDaemon('status')
  } catch {
    return undefined
  }
}

function validateDaemonStatus(status: DnsHelperStatus): DnsHelperStatus {
  if (status.version !== undefined && status.version !== dnsHelperProtocolVersion) {
    throw new Error('Sparkle macOS DNS helper 协议版本不兼容，请升级应用')
  }
  return status
}

/**
 * Install/update the root-owned restricted LaunchDaemon only when the socket
 * is absent, its wire protocol is incompatible, or its executable identity is
 * stale. status/release never invoke elevation, so ordinary lifecycle cleanup
 * cannot trigger an admin prompt.
 */
export async function ensureMihomoDnsHelperDaemon(): Promise<DnsHelperStatus> {
  if (process.platform !== 'darwin') return unsupportedStatus('仅 macOS 支持 Sparkle DNS helper')
  if (!isMihomoDnsHelperAvailable()) throw new Error('Sparkle macOS DNS helper 未随应用安装')
  if (installInFlight) return installInFlight

  installInFlight = (async () => {
    const buildId = await packagedHelperBuildId()
    const existing = await daemonStatus()
    if (needsDnsHelperInstall(existing, buildId) === 'ready') {
      if (existing?.error) throw new Error(existing.error)
      return existing as DnsHelperStatus
    }

    const auth = await ensureAuthFile()
    const uid = process.getuid?.()
    if (!uid || uid <= 0) throw new Error('无法确定当前 macOS 应用用户')
    const output = await execWithElevationOutput(
      dnsHelperPath(),
      buildDnsHelperInstallArgs(dnsHelperPath(), auth, uid, buildId)
    )
    const installed = validateDaemonStatus(parseHelperOutput(output))
    if (installed.error) throw new Error(installed.error)

    for (let attempt = 0; attempt < 20; attempt++) {
      const ready = await daemonStatus()
      if (ready && needsDnsHelperInstall(ready, buildId) === 'ready') {
        validateDaemonStatus(ready)
        if (ready.error) throw new Error(ready.error)
        return ready
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 150)
      })
    }
    throw unavailableError()
  })().finally(() => {
    installInFlight = undefined
  })
  return installInFlight
}

export async function acquireMihomoDnsLease(listen: string): Promise<DnsHelperStatus> {
  const parsed = parseDnsLeaseTarget(listen)
  if (!parsed.ok) throw new Error(parsed.error)
  if (process.platform !== 'darwin') return unsupportedStatus('仅 macOS 支持 Sparkle DNS helper')
  if (acquireInFlight) return acquireInFlight

  acquireInFlight = ensureMihomoDnsHelperDaemon()
    .then(() => requestDaemon('acquire', parsed.value.listen))
    .then((status) => {
      validateDaemonStatus(status)
      if (!status.supported || status.error || !status.active || !status.healthy) {
        throw new Error(status.error || 'macOS DNS helper 未能验证 Mihomo DNS 监听器')
      }
      return status
    })
    .finally(() => {
      acquireInFlight = undefined
    })
  return acquireInFlight
}

/** Release is idempotent and never invokes elevation. */
export async function releaseMihomoDnsLease(): Promise<DnsHelperStatus> {
  if (process.platform !== 'darwin') return unsupportedStatus('仅 macOS 支持 Sparkle DNS helper')
  if (releaseInFlight) return releaseInFlight
  releaseInFlight = requestDaemon('release').finally(() => {
    releaseInFlight = undefined
  })
  return releaseInFlight
}

/** Status is deliberately a socket query; it must not show an admin prompt. */
export async function getMihomoDnsLeaseStatus(): Promise<DnsHelperStatus> {
  if (process.platform !== 'darwin') return unsupportedStatus()
  try {
    return validateDaemonStatus(await requestDaemon('status'))
  } catch (error) {
    return unsupportedStatus(error instanceof Error ? error.message : String(error))
  }
}

/** Reconcile is also socket-only; the LaunchDaemon performs it at boot. */
export async function reconcileMihomoDnsLease(): Promise<DnsHelperStatus> {
  if (process.platform !== 'darwin') return unsupportedStatus()
  try {
    return validateDaemonStatus(await requestDaemon('reconcile'))
  } catch (error) {
    return unsupportedStatus(error instanceof Error ? error.message : String(error))
  }
}
