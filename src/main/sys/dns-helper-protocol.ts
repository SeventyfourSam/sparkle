import { isIP } from 'node:net'
import path from 'node:path'

export const dnsHelperProtocolVersion = 1

export interface DnsLeaseTarget {
  listen: string
  address: '127.0.0.1' | '::1'
  port: number
}

export interface DnsHelperStatus {
  version?: number
  /** Digest of the installed helper executable, independent of wire/schema version. */
  build_id?: string
  supported: boolean
  active: boolean
  healthy: boolean
  mode?: 'mihomo-listener'
  lease_id?: string
  listen?: string
  target?: { address: string; port: number }
  service_id?: string
  conflict?: boolean
  error?: string
}

export type DnsLeasePhase = 'pending' | 'active'

export interface DnsLeaseState {
  version: 1
  phase: DnsLeasePhase
  leaseId: string
  target: DnsLeaseTarget
  serviceId: string
  protocolExists: boolean
  protocolEnabled: boolean
  originalConfiguration: Record<string, unknown> | null
  watcherPid?: number
}

export type ParseDnsTargetResult =
  { ok: true; value: DnsLeaseTarget } | { ok: false; error: string }

export type DnsHelperInstallDecision = 'ready' | 'install'

/**
 * Decide whether the packaged helper must replace the daemon reachable on the
 * socket.  A missing or incompatible wire version is an install/update case;
 * it is not a reason to strand an existing v1 lease.
 */
export function needsDnsHelperInstall(
  existing: Pick<DnsHelperStatus, 'supported' | 'version' | 'build_id'> | undefined,
  packagedBuildId: string
): DnsHelperInstallDecision {
  if (
    existing?.supported &&
    existing.version === dnsHelperProtocolVersion &&
    existing.build_id === packagedBuildId
  ) {
    return 'ready'
  }
  return 'install'
}

/** Keep the privileged installer argument contract pure and testable. */
export function buildDnsHelperInstallArgs(
  source: string,
  authPath: string,
  uid: number,
  buildId: string
): string[] {
  if (!path.isAbsolute(authPath) || path.basename(authPath) !== 'dns-helper-auth') {
    throw new Error('DNS helper installer requires an absolute auth file path')
  }
  return [
    'install',
    '--json',
    '--source',
    source,
    '--auth-file',
    authPath,
    '--uid',
    String(uid),
    '--build-id',
    buildId
  ]
}

export type DnsLeaseReconcileDecision = 'noop' | 'release' | 'error'

/**
 * Disabled mode is a clean no-op when no daemon/socket is installed, but a
 * daemon-owned active lease must be released explicitly.
 */
export function decideDnsLeaseReconcile(
  mode: 'none' | 'mihomo-listener',
  status: Pick<DnsHelperStatus, 'supported' | 'active' | 'conflict' | 'error'>
): DnsLeaseReconcileDecision {
  if (!status.supported) return mode === 'mihomo-listener' ? 'error' : 'noop'
  if (status.conflict || status.error) return 'error'
  if (mode === 'none' && status.active) return 'release'
  return 'noop'
}

export function isDisablingMihomoListenerPatch(patch: Partial<MihomoConfig>): boolean {
  return patch.tun?.enable === false || patch.dns?.enable === false || patch.dns?.listen === ''
}

/** Parse and constrain the only target accepted by the privileged helper. */
export function parseDnsLeaseTarget(value: string | undefined): ParseDnsTargetResult {
  if (!value || value.trim() === '') {
    return { ok: false, error: 'dns.listen 不能为空' }
  }
  const listen = value.trim()
  let address: string
  let portText: string

  if (listen.startsWith('[')) {
    const close = listen.indexOf(']')
    if (close < 0 || listen.slice(close + 1, close + 2) !== ':') {
      return { ok: false, error: 'IPv6 dns.listen 必须使用 [地址]:端口 格式' }
    }
    address = listen.slice(1, close)
    portText = listen.slice(close + 2)
    if (address !== '::1') {
      return { ok: false, error: '系统 DNS helper 只允许 ::1 回环地址' }
    }
  } else {
    const separator = listen.lastIndexOf(':')
    if (separator <= 0 || listen.slice(0, separator).includes(':')) {
      return { ok: false, error: 'dns.listen 必须是 127.0.0.1:端口 或 [::1]:端口' }
    }
    address = listen.slice(0, separator)
    portText = listen.slice(separator + 1)
    if (address !== '127.0.0.1') {
      return { ok: false, error: '系统 DNS helper 只允许 127.0.0.1 回环地址' }
    }
  }

  if (isIP(address) !== (address === '::1' ? 6 : 4)) {
    return { ok: false, error: 'dns.listen 主机地址无效' }
  }
  if (!/^\d+$/.test(portText)) {
    return { ok: false, error: 'dns.listen 端口无效' }
  }
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 53) {
    return { ok: false, error: '系统 DNS helper 需要 1-65535 且非 53 端口' }
  }

  return {
    ok: true,
    value: {
      listen,
      address: address as '127.0.0.1' | '::1',
      port
    }
  }
}

export function isOwnedDnsTarget(
  addresses: readonly string[] | undefined,
  port: number | undefined,
  target: DnsLeaseTarget
): boolean {
  return (
    Array.isArray(addresses) &&
    addresses.length === 1 &&
    addresses[0] === target.address &&
    port === target.port
  )
}

/**
 * Merge only the DNS fields Sparkle owns back into the current dictionary.
 * Other SystemConfiguration fields are deliberately retained.
 */
export function restoreOwnedDnsFields(
  current: Record<string, unknown>,
  original: Record<string, unknown> | null
): Record<string, unknown> {
  const restored = { ...current }
  const addressesKey = 'ServerAddresses'
  const portKey = 'ServerPort'

  if (original && Object.prototype.hasOwnProperty.call(original, addressesKey)) {
    restored[addressesKey] = original[addressesKey]
  } else {
    delete restored[addressesKey]
  }

  if (original && Object.prototype.hasOwnProperty.call(original, portKey)) {
    restored[portKey] = original[portKey]
  } else {
    delete restored[portKey]
  }

  return restored
}

export function nextAcquireAction(
  state: DnsLeaseState | undefined,
  target: DnsLeaseTarget
): 'create' | 'reuse' | 'restore-before-create' {
  if (!state) return 'create'
  if (
    state.phase === 'active' &&
    state.target.address === target.address &&
    state.target.port === target.port
  ) {
    return 'reuse'
  }
  return 'restore-before-create'
}
