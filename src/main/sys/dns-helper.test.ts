import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isOwnedDnsTarget,
  nextAcquireAction,
  parseDnsLeaseTarget,
  restoreOwnedDnsFields,
  type DnsLeaseState
} from './dns-helper-protocol'

test('accepts only loopback non-53 DNS lease targets', () => {
  assert.deepEqual(parseDnsLeaseTarget('127.0.0.1:1053'), {
    ok: true,
    value: { listen: '127.0.0.1:1053', address: '127.0.0.1', port: 1053 }
  })
  assert.deepEqual(parseDnsLeaseTarget('[::1]:5353'), {
    ok: true,
    value: { listen: '[::1]:5353', address: '::1', port: 5353 }
  })
  assert.equal(parseDnsLeaseTarget('0.0.0.0:1053').ok, false)
  assert.equal(parseDnsLeaseTarget('127.0.0.1:53').ok, false)
  assert.equal(parseDnsLeaseTarget('127.0.0.1:bad').ok, false)
  assert.equal(parseDnsLeaseTarget('::1:1053').ok, false)
})

test('renderer listen parsing accepts ordinary IPv4 host:port values', async () => {
  const { isValidListenAddress, parseListenAddress } =
    await import('../../renderer/src/utils/validate')
  assert.equal(isValidListenAddress('127.0.0.1:1053').ok, true)
  assert.deepEqual(parseListenAddress('example.test:1053'), {
    ok: true,
    value: { host: 'example.test', port: 1053, wildcard: false }
  })
})

test('lease transitions are idempotent and do not reuse another target', () => {
  const target = parseDnsLeaseTarget('127.0.0.1:1053')
  assert.equal(target.ok, true)
  if (!target.ok) return
  const base = {
    version: 1 as const,
    phase: 'active' as const,
    leaseId: 'lease-1',
    target: target.value,
    serviceId: 'service-1',
    protocolExists: true,
    protocolEnabled: true,
    originalConfiguration: null
  } satisfies DnsLeaseState
  assert.equal(nextAcquireAction(undefined, target.value), 'create')
  assert.equal(nextAcquireAction(base, target.value), 'reuse')
  const otherTarget = parseDnsLeaseTarget('127.0.0.1:2053')
  assert.equal(otherTarget.ok, true)
  if (!otherTarget.ok) return
  assert.equal(nextAcquireAction(base, otherTarget.value), 'restore-before-create')
  assert.equal(isOwnedDnsTarget(['127.0.0.1'], 1053, target.value), true)
  assert.equal(isOwnedDnsTarget(['192.0.2.1'], 1053, target.value), false)
})

test('restore merges only Sparkle-owned fields', () => {
  const current = {
    ServerAddresses: ['127.0.0.1'],
    ServerPort: 1053,
    SearchDomains: ['corp.example'],
    SupplementalMatchDomains: ['corp.example']
  }
  const restored = restoreOwnedDnsFields(current, {
    ServerAddresses: ['192.0.2.53'],
    SearchDomains: ['original.example']
  })
  assert.deepEqual(restored, {
    ServerAddresses: ['192.0.2.53'],
    SearchDomains: ['corp.example'],
    SupplementalMatchDomains: ['corp.example']
  })
})
