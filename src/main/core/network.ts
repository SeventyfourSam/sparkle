import { execFile } from 'child_process'
import { net } from 'electron'
import os from 'os'
import { promisify } from 'util'
import { getAppConfig, getControledMihomoConfig, patchAppConfig } from '../config'
import { getRuntimeConfig } from './factory'
import { setSysDns } from '../service/api'
import {
  acquireMihomoDnsLease,
  ensureMihomoDnsHelperDaemon,
  isMihomoDnsHelperAvailable,
  releaseMihomoDnsLease,
  reconcileMihomoDnsLease
} from '../sys/dns-helper'
import { parseDnsLeaseTarget } from '../sys/dns-helper-protocol'
import { triggerSysProxy } from '../sys/sysproxy'
import { appendAppLog } from '../utils/log'

export interface NetworkCoreController {
  shouldStartCore: (networkDownHandled: boolean) => boolean
  startCore: () => Promise<void>
  stopCore: () => Promise<void>
}

let setPublicDNSTimer: NodeJS.Timeout | null = null
let recoverDNSTimer: NodeJS.Timeout | null = null
let networkDetectionTimer: NodeJS.Timeout | null = null
let networkDetectionGeneration = 0
let networkDownHandled = false

export async function getDefaultDevice(): Promise<string> {
  const execFilePromise = promisify(execFile)
  const { stdout: deviceOut } = await execFilePromise('route', ['-n', 'get', 'default'])
  let device = deviceOut.split('\n').find((s) => s.includes('interface:'))
  device = device?.trim().split(' ').slice(1).join(' ')
  if (!device) throw new Error('Get device failed')
  return device
}

async function getDefaultService(): Promise<string> {
  const execFilePromise = promisify(execFile)
  const device = await getDefaultDevice()
  const { stdout: order } = await execFilePromise('networksetup', ['-listnetworkserviceorder'])
  const block = order.split('\n\n').find((s) => s.includes(`Device: ${device}`))
  if (!block) throw new Error('Get networkservice failed')
  for (const line of block.split('\n')) {
    if (line.match(/^\(\d+\).*/)) {
      return line.trim().split(' ').slice(1).join(' ')
    }
  }
  throw new Error('Get service failed')
}

async function getOriginDNS(): Promise<void> {
  const execFilePromise = promisify(execFile)
  const service = await getDefaultService()
  const { stdout: dns } = await execFilePromise('networksetup', ['-getdnsservers', service])
  if (dns.startsWith("There aren't any DNS Servers set on")) {
    await patchAppConfig({ originDNS: 'Empty' })
  } else {
    await patchAppConfig({ originDNS: dns.trim().replace(/\n/g, ' ') })
  }
}

async function setDNS(dns: string, mode: 'none' | 'exec' | 'service'): Promise<void> {
  const service = await getDefaultService()
  const dnsServers = dns.split(' ')
  if (mode === 'exec') {
    const execFilePromise = promisify(execFile)
    await execFilePromise('networksetup', ['-setdnsservers', service, ...dnsServers])
    return
  }
  if (mode === 'service') {
    await setSysDns(service, dnsServers)
    return
  }
}

export interface MihomoSystemDnsValidation {
  ok: boolean
  error?: string
  listen?: string
  address?: string
  port?: number
}

export function parseLoopbackListen(
  listen: string | undefined
): { ok: true; listen: string; address: string; port: number } | { ok: false; error: string } {
  const result = parseDnsLeaseTarget(listen)
  if (!result.ok) return result
  return { ok: true, ...result.value }
}

function isSystemDnsUpstream(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^(?:system|system:\/\/|dhcp:\/\/system)(?:#|$)/i.test(value.trim())
  )
}

function hasSystemDnsUpstream(dns: MihomoDNSConfig | undefined): boolean {
  if (!dns) return false
  const values: unknown[] = [
    ...(dns['default-nameserver'] || []),
    ...(dns.nameserver || []),
    ...(dns.fallback || []),
    ...(dns['proxy-server-nameserver'] || []),
    ...(dns['direct-nameserver'] || []),
    ...Object.values(dns['nameserver-policy'] || {}).flat(),
    ...Object.values(dns['proxy-server-nameserver-policy'] || {}).flat()
  ]
  return values.some(isSystemDnsUpstream)
}

export function validateMihomoSystemDnsMode(
  appConfig: AppConfig,
  controlledConfig: Partial<MihomoConfig>,
  runtimeConfig: Partial<MihomoConfig> | undefined
): MihomoSystemDnsValidation {
  if (process.platform !== 'darwin') return { ok: false, error: '仅 macOS 支持系统 DNS 模式' }
  if (appConfig.macosSystemDnsMode !== 'mihomo-listener') return { ok: true }
  if (appConfig.controlDns === false) return { ok: false, error: '必须启用受控 DNS' }
  if (controlledConfig.dns?.enable !== true || runtimeConfig?.dns?.enable !== true) {
    return { ok: false, error: '必须启用 Mihomo DNS' }
  }
  if (controlledConfig.tun?.enable !== true || runtimeConfig?.tun?.enable !== true) {
    return { ok: false, error: '必须启用 Tun' }
  }
  const dns = runtimeConfig?.dns
  if (hasSystemDnsUpstream(dns)) {
    return { ok: false, error: 'DNS 上游使用 system 会与系统 DNS 形成递归，已拒绝' }
  }
  const parsed = parseLoopbackListen(dns?.listen)
  if (!parsed.ok) return parsed
  return parsed
}

/** Acquire the system resolver lease only after the final Mihomo runtime is ready. */
export async function acquireMihomoSystemDNSLease(): Promise<void> {
  if (process.platform !== 'darwin') return
  const [appConfig, controlledConfig, runtimeConfig] = await Promise.all([
    getAppConfig(),
    getControledMihomoConfig(),
    getRuntimeConfig()
  ])
  const validation = validateMihomoSystemDnsMode(appConfig, controlledConfig, runtimeConfig)
  if (appConfig.macosSystemDnsMode !== 'mihomo-listener') return
  if (!validation.ok || !validation.listen) {
    throw new Error(validation.error || 'macOS Mihomo system DNS prerequisites are not met')
  }
  await ensureMihomoDnsHelperDaemon()
  const status = await acquireMihomoDnsLease(validation.listen)
  if (!status.active || !status.healthy) {
    throw new Error(status.error || 'macOS DNS helper 未能验证 Mihomo DNS 监听器')
  }
  await appendAppLog(`[DNS]: acquired macOS default resolver lease for ${validation.listen}\n`)
}

/** Release and verify the resolver before stopping the Mihomo listener. */
export async function releaseMihomoSystemDNSLease(): Promise<void> {
  if (process.platform !== 'darwin') return
  const appConfig = await getAppConfig()
  // A configured listener mode is the durable marker that a crash may have
  // left a root-owned lease behind.  In the normal disabled mode do not invoke
  // the helper (and do not prompt for elevation) on every ordinary core stop.
  if (appConfig.macosSystemDnsMode !== 'mihomo-listener') return
  // If launchd has not restarted after a crash/update, ensure it is present
  // once. The normal path is a socket request and never prompts.
  await ensureMihomoDnsHelperDaemon()
  const released = await releaseMihomoDnsLease()
  if (!released.supported || released.active || released.conflict || released.error) {
    throw new Error(released.error || '系统 DNS 仍指向 Mihomo 监听器，无法安全停止内核')
  }
  if (released.active === false) {
    await appendAppLog('[DNS]: restored macOS default resolver\n')
  }
}

/** Reconcile an interrupted helper transaction without acquiring anything. */
export async function reconcileMihomoSystemDNSLease(): Promise<void> {
  if (process.platform !== 'darwin') return
  const appConfig = await getAppConfig()
  const listenerMode = appConfig.macosSystemDnsMode === 'mihomo-listener'
  if (listenerMode) await ensureMihomoDnsHelperDaemon()
  if (!isMihomoDnsHelperAvailable()) return
  const status = await reconcileMihomoDnsLease()
  if (listenerMode && !status.supported) {
    throw new Error(status.error || 'macOS DNS helper daemon 不可用，无法安全 reconcile 系统 DNS')
  }
  if (status.conflict || status.error) {
    throw new Error(status.error || 'macOS DNS helper 检测到外部 DNS 冲突')
  }
}

export async function setPublicDNS(): Promise<void> {
  if (process.platform !== 'darwin') return
  if (net.isOnline()) {
    const { originDNS, autoSetDNSMode = 'none' } = await getAppConfig()
    if (!originDNS) {
      await getOriginDNS()
      await setDNS('223.5.5.5', autoSetDNSMode)
    }
  } else {
    if (setPublicDNSTimer) clearTimeout(setPublicDNSTimer)
    setPublicDNSTimer = setTimeout(() => setPublicDNS(), 5000)
  }
}

export async function recoverDNS(): Promise<void> {
  if (process.platform !== 'darwin') return
  if (net.isOnline()) {
    const { originDNS, autoSetDNSMode = 'none' } = await getAppConfig()
    if (originDNS) {
      await setDNS(originDNS, autoSetDNSMode)
      await patchAppConfig({ originDNS: undefined })
    }
  } else {
    if (recoverDNSTimer) clearTimeout(recoverDNSTimer)
    recoverDNSTimer = setTimeout(() => recoverDNS(), 5000)
  }
}

export async function startNetworkDetectionController(
  controller: NetworkCoreController
): Promise<void> {
  const generation = ++networkDetectionGeneration
  let detecting = false
  const { networkDetectionBypass = [], networkDetectionInterval = 10 } = await getAppConfig()
  const { tun: { device = process.platform === 'darwin' ? undefined : 'mihomo' } = {} } =
    await getControledMihomoConfig()
  if (generation !== networkDetectionGeneration) return
  if (networkDetectionTimer) {
    clearInterval(networkDetectionTimer)
  }
  const extendedBypass = networkDetectionBypass.concat(
    [device, 'lo', 'docker0', 'utun'].filter((item): item is string => item !== undefined)
  )

  networkDetectionTimer = setInterval(async () => {
    if (detecting || generation !== networkDetectionGeneration) return
    detecting = true
    try {
      const { onlyActiveDevice = false, sysProxy = { enable: false } } = await getAppConfig()
      if (generation !== networkDetectionGeneration) return
      if (isAnyNetworkInterfaceUp(extendedBypass) && net.isOnline()) {
        if (controller.shouldStartCore(networkDownHandled)) {
          await controller.startCore()
          if (generation !== networkDetectionGeneration) return
          if (sysProxy.enable) await triggerSysProxy(true, onlyActiveDevice)
          networkDownHandled = false
        }
      } else if (!networkDownHandled) {
        if (sysProxy.enable) await triggerSysProxy(false, onlyActiveDevice, true)
        if (generation !== networkDetectionGeneration) return
        await controller.stopCore()
        if (generation === networkDetectionGeneration) {
          networkDownHandled = true
        }
      }
    } catch (error) {
      appendAppLog(`[Network]: network detection failed, ${error}\n`).catch(() => {})
    } finally {
      detecting = false
    }
  }, networkDetectionInterval * 1000)
}

export function stopNetworkDetection(): void {
  networkDetectionGeneration++
  if (networkDetectionTimer) {
    clearInterval(networkDetectionTimer)
    networkDetectionTimer = null
  }
}

function isAnyNetworkInterfaceUp(excludedKeywords: string[] = []): boolean {
  const interfaces = os.networkInterfaces()
  return Object.entries(interfaces).some(([name, ifaces]) => {
    if (excludedKeywords.some((keyword) => name.includes(keyword))) return false

    return ifaces?.some((iface) => {
      return !iface.internal && (iface.family === 'IPv4' || iface.family === 'IPv6')
    })
  })
}
