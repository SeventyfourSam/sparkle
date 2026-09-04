import {
  getAppConfig,
  getControledMihomoConfig,
  patchAppConfig,
  patchControledMihomoConfig
} from '../config'
import { generateProfile, getRuntimeConfig } from '../core/factory'
import {
  acquireMihomoDnsLease,
  ensureMihomoDnsHelperDaemon,
  getMihomoDnsLeaseStatus,
  releaseMihomoDnsLease,
  reconcileMihomoDnsLease
} from './dns-helper'
import {
  decideDnsLeaseReconcile,
  parseDnsLeaseTarget,
  shouldClearMihomoSystemDnsMode
} from './dns-helper-protocol'
import { appendAppLog } from '../utils/log'

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
  const parsed = parseDnsLeaseTarget(dns?.listen)
  if (!parsed.ok) return parsed
  return { ok: true, ...parsed.value }
}

/**
 * Preflight app-config mode changes before they become durable. Enabling the
 * mode validates the final generated profile and installs the fixed helper;
 * disabling it restores the resolver before clearing the mode marker.
 */
export async function prepareMihomoSystemDnsAppPatch(
  patch: Partial<AppConfig>,
  currentConfig: AppConfig
): Promise<Partial<AppConfig>> {
  if (
    (patch.macosSystemDnsMode === 'none' || patch.controlDns === false) &&
    currentConfig.macosSystemDnsMode === 'mihomo-listener'
  ) {
    await releaseMihomoSystemDNSLease()
    if (patch.controlDns === false && patch.macosSystemDnsMode === undefined) {
      patch = { ...patch, macosSystemDnsMode: 'none' }
    }
  }

  if (
    process.platform === 'darwin' &&
    patch.macosSystemDnsMode === 'mihomo-listener' &&
    currentConfig.macosSystemDnsMode !== 'mihomo-listener'
  ) {
    let runtimeConfig = await getRuntimeConfig()
    if (!runtimeConfig) {
      await generateProfile()
      runtimeConfig = await getRuntimeConfig()
    }
    const validation = validateMihomoSystemDnsMode(
      { ...currentConfig, macosSystemDnsMode: 'mihomo-listener' },
      await getControledMihomoConfig(),
      runtimeConfig
    )
    if (!validation.ok) {
      throw new Error(validation.error || 'macOS Mihomo system DNS prerequisites are not met')
    }
    await ensureMihomoDnsHelperDaemon()
  }

  return patch
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
  // left a root-owned lease behind. Ordinary release calls in disabled mode
  // do not invoke the helper and never prompt for elevation.
  if (appConfig.macosSystemDnsMode !== 'mihomo-listener') return
  // Release is deliberately socket-only. If launchd is unavailable, fail
  // closed and keep the Mihomo core alive rather than changing DNS blindly.
  const released = await releaseMihomoDnsLease()
  if (!released.supported || released.active || released.conflict || released.error) {
    throw new Error(released.error || '系统 DNS 仍指向 Mihomo 监听器，无法安全停止内核')
  }
  if (released.active === false) {
    await appendAppLog('[DNS]: restored macOS default resolver\n')
  }
}

/** Route controlled DNS/Tun/listener disables through resolver release first. */
export async function patchControlledConfigSafely(patch: Partial<MihomoConfig>): Promise<boolean> {
  const currentConfig = await getAppConfig()
  const modeChanged = shouldClearMihomoSystemDnsMode(currentConfig.macosSystemDnsMode, patch)
  if (modeChanged) {
    await releaseMihomoSystemDNSLease()
    await patchAppConfig({ macosSystemDnsMode: 'none' })
  }
  await patchControledMihomoConfig(patch)
  return modeChanged
}

/** Reconcile an interrupted helper transaction without acquiring anything. */
export async function reconcileMihomoSystemDNSLease(): Promise<void> {
  if (process.platform !== 'darwin') return
  const appConfig = await getAppConfig()
  const listenerMode = appConfig.macosSystemDnsMode === 'mihomo-listener'
  if (!listenerMode) {
    // Disabled mode never migrates or reacquires on a new primary service. A
    // status query followed by direct release is the only cleanup path.
    const status = await getMihomoDnsLeaseStatus()
    const decision = decideDnsLeaseReconcile('none', status)
    if (decision === 'noop') return
    if (decision === 'error') {
      throw new Error(status.error || 'macOS DNS helper 检测到外部 DNS 冲突')
    }
    const released = await releaseMihomoDnsLease()
    if (!released.supported || released.active || released.conflict || released.error) {
      throw new Error(released.error || 'macOS DNS helper stale lease 无法安全释放')
    }
    return
  }

  await ensureMihomoDnsHelperDaemon()
  const status = await reconcileMihomoDnsLease()
  const decision = decideDnsLeaseReconcile('mihomo-listener', status)
  if (decision === 'noop') return
  if (decision === 'error') {
    throw new Error(status.error || 'macOS DNS helper daemon 不可用，无法安全 reconcile 系统 DNS')
  }
}
