import { isIP } from 'node:net'

export interface DnsLeaseTarget {
  listen: string
  address: '127.0.0.1' | '::1'
  port: number
}

export interface DnsHelperStatus {
  version?: number
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
