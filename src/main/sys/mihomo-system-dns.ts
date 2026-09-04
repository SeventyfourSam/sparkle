import {
  getAppConfig,
  getControledMihomoConfig,
  patchAppConfig,
  patchControledMihomoConfig
} from '../config'
import { getRuntimeConfig } from '../core/factory'
import {
  acquireMihomoDnsLease,
  ensureMihomoDnsHelperDaemon,
  getMihomoDnsLeaseStatus,
  releaseMihomoDnsLease,
  reconcileMihomoDnsLease
} from './dns-helper'
import {
  decideDnsLeaseReconcile,
  hasMihomoDnsListener,
  isDisablingMihomoListenerPatch,
  parseDnsLeaseTarget,
  shouldManageMihomoSystemDns
} from './dns-helper-protocol'
import { appendAppLog } from '../utils/log'

export { hasMihomoDnsListener, shouldManageMihomoSystemDns }

export interface MihomoSystemDnsValidation {
  ok: boolean
  error?: string
  listen?: string
  address?: string
  port?: number
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

export function validateMihomoSystemDnsConfig(
  appConfig: AppConfig,
  controlledConfig: Partial<MihomoConfig>,
  runtimeConfig: Partial<MihomoConfig> | undefined
): MihomoSystemDnsValidation {
  if (process.platform !== 'darwin') return { ok: false, error: '仅 macOS 支持系统 DNS 模式' }
  if (!hasMihomoDnsListener(controlledConfig)) return { ok: true }
  if (appConfig.controlDns === false) return { ok: false, error: '必须启用受控 DNS' }
  if (controlledConfig.dns?.enable !== true || runtimeConfig?.dns?.enable !== true) {
    return { ok: false, error: '配置 dns.listen 时必须启用 Mihomo DNS' }
  }
  if (controlledConfig.tun?.enable !== true || runtimeConfig?.tun?.enable !== true) {
    return { ok: false, error: '配置 dns.listen 时必须启用 Tun' }
  }
  const dns = runtimeConfig.dns
  if (hasSystemDnsUpstream(dns)) {
    return { ok: false, error: 'DNS 上游使用 system 会与系统 DNS 形成递归，已拒绝' }
  }
  const parsed = parseDnsLeaseTarget(dns.listen)
  if (!parsed.ok) return parsed
  return { ok: true, ...parsed.value }
}

/** Turning off controlled DNS must restore an active listener lease first. */
export async function prepareMihomoSystemDnsAppPatch(
  patch: Partial<AppConfig>,
  currentConfig: AppConfig
): Promise<Partial<AppConfig>> {
  if (patch.controlDns === false && currentConfig.controlDns !== false) {
    await releaseMihomoSystemDNSLease()
  }
  return patch
}

/** Acquire automatically once the configured Mihomo listener is ready. */
export async function acquireMihomoSystemDNSLease(): Promise<void> {
  if (process.platform !== 'darwin') return
  const [appConfig, controlledConfig, runtimeConfig] = await Promise.all([
    getAppConfig(),
    getControledMihomoConfig(),
    getRuntimeConfig()
  ])
  if (!shouldManageMihomoSystemDns(appConfig.controlDns !== false, controlledConfig)) return

  const validation = validateMihomoSystemDnsConfig(appConfig, controlledConfig, runtimeConfig)
  if (!validation.ok || !validation.listen) {
    throw new Error(validation.error || 'macOS Mihomo system DNS prerequisites are not met')
  }
  await ensureMihomoDnsHelperDaemon()
  const status = await acquireMihomoDnsLease(validation.listen)
  if (!status.active || !status.healthy) {
    throw new Error(status.error || 'macOS DNS helper 未检测到 Mihomo DNS 监听端口')
  }

  // dns.listen supersedes Sparkle's legacy public-DNS replacement. Clear an
  // old persisted choice once so removing dns.listen cannot revive it later.
  if (appConfig.autoSetDNSMode && appConfig.autoSetDNSMode !== 'none') {
    await patchAppConfig({ autoSetDNSMode: 'none' })
  }
  await appendAppLog(`[DNS]: acquired macOS default resolver lease for ${validation.listen}\n`)
}

/** Release and verify the resolver before stopping Tun or Mihomo. */
export async function releaseMihomoSystemDNSLease(): Promise<void> {
  if (process.platform !== 'darwin') return
  const status = await getMihomoDnsLeaseStatus()
  if (!status.supported) {
    const [appConfig, controlledConfig] = await Promise.all([
      getAppConfig(),
      getControledMihomoConfig()
    ])
    if (shouldManageMihomoSystemDns(appConfig.controlDns !== false, controlledConfig)) {
      throw new Error(status.error || 'macOS DNS helper daemon 不可用，无法安全停止内核')
    }
    return
  }
  if (status.auth_failed) {
    throw new Error(status.error || 'macOS DNS helper 请求认证失败')
  }
  if (!status.active && !status.lease_id && !status.error) return

  const released = await releaseMihomoDnsLease()
  if (!released.supported || released.active || released.conflict || released.error) {
    throw new Error(released.error || '系统 DNS 仍指向 Mihomo 监听器，无法安全停止内核')
  }
  await appendAppLog('[DNS]: restored macOS default resolver\n')
}

/** Route controlled DNS/Tun/listener disables through resolver release first. */
export async function patchControlledConfigSafely(patch: Partial<MihomoConfig>): Promise<void> {
  if (isDisablingMihomoListenerPatch(patch)) await releaseMihomoSystemDNSLease()
  await patchControledMihomoConfig(patch)
}

/** Runtime-only shutdowns also release the system resolver before the listener. */
export async function prepareMihomoSystemDnsRuntimePatch(
  patch: Partial<MihomoConfig>
): Promise<void> {
  if (process.platform !== 'darwin' || !isDisablingMihomoListenerPatch(patch)) return
  await releaseMihomoSystemDNSLease()
}

/** Reconcile an interrupted transaction without acquiring a new lease. */
export async function reconcileMihomoSystemDNSLease(): Promise<void> {
  if (process.platform !== 'darwin') return
  const [appConfig, controlledConfig] = await Promise.all([
    getAppConfig(),
    getControledMihomoConfig()
  ])
  const listenerExpected = shouldManageMihomoSystemDns(
    appConfig.controlDns !== false,
    controlledConfig
  )

  if (!listenerExpected) {
    const status = await getMihomoDnsLeaseStatus()
    const decision = decideDnsLeaseReconcile(false, status)
    if (decision === 'noop') return
    if (decision === 'error') {
      throw new Error(status.error || 'macOS DNS helper 检测到无法安全恢复的 DNS 状态')
    }
    const released = await releaseMihomoDnsLease()
    if (!released.supported || released.active || released.conflict || released.error) {
      throw new Error(released.error || 'macOS DNS helper stale lease 无法安全释放')
    }
    return
  }

  const parsed = parseDnsLeaseTarget(controlledConfig.dns?.listen)
  if (!parsed.ok) throw new Error(parsed.error)
  await ensureMihomoDnsHelperDaemon()
  const status = await reconcileMihomoDnsLease()
  const decision = decideDnsLeaseReconcile(true, status)
  if (decision === 'error') {
    throw new Error(status.error || 'macOS DNS helper daemon 不可用，无法安全 reconcile 系统 DNS')
  }
}
