import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildDnsHelperInstallArgs,
  decideDnsLeaseReconcile,
  dnsHelperProtocolVersion,
  isOwnedDnsTarget,
  needsDnsHelperInstall,
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

test('installer receives the auth file path, never the token value', () => {
  const authPath = '/Users/test/Library/Application Support/Sparkle/dns-helper-auth'
  const token = 'a'.repeat(64)
  const args = buildDnsHelperInstallArgs(
    '/Applications/Sparkle.app/Contents/Resources/files/sparkle-dns-helper',
    authPath,
    501,
    token
  )
  const authIndex = args.indexOf('--auth-file')
  assert.equal(args[authIndex + 1], authPath)
  assert.notEqual(args[authIndex + 1], token)
  assert.throws(
    () =>
      buildDnsHelperInstallArgs(
        '/Applications/Sparkle.app/Contents/Resources/files/sparkle-dns-helper',
        token,
        501,
        token
      ),
    /absolute auth file path/
  )
})

test('helper update decision separates wire compatibility from build identity', () => {
  const buildId = 'b'.repeat(64)
  assert.equal(needsDnsHelperInstall(undefined, buildId), 'install')
  assert.equal(
    needsDnsHelperInstall(
      { supported: true, version: dnsHelperProtocolVersion, build_id: buildId },
      buildId
    ),
    'ready'
  )
  assert.equal(
    needsDnsHelperInstall(
      { supported: true, version: dnsHelperProtocolVersion + 1, build_id: buildId },
      buildId
    ),
    'install'
  )
  assert.equal(
    needsDnsHelperInstall(
      { supported: true, version: dnsHelperProtocolVersion, build_id: 'c'.repeat(64) },
      buildId
    ),
    'install'
  )
})

test('disabled reconcile is a no-op without a daemon and releases a stale lease', () => {
  assert.equal(
    decideDnsLeaseReconcile('none', {
      supported: false,
      active: false,
      conflict: false,
      error: 'socket missing'
    }),
    'noop'
  )
  assert.equal(
    decideDnsLeaseReconcile('none', {
      supported: true,
      active: true,
      conflict: false,
      error: undefined
    }),
    'release'
  )
  assert.equal(
    decideDnsLeaseReconcile('mihomo-listener', {
      supported: false,
      active: false,
      conflict: false,
      error: 'daemon missing'
    }),
    'error'
  )
})

test('controlled config disabling patches are lifecycle-routed', async () => {
  const { isDisablingMihomoListenerPatch } = await import('./dns-helper-protocol')
  assert.equal(isDisablingMihomoListenerPatch({ tun: { enable: false } }), true)
  assert.equal(isDisablingMihomoListenerPatch({ dns: { enable: false } }), true)
  assert.equal(isDisablingMihomoListenerPatch({ dns: { listen: '' } }), true)
  assert.equal(isDisablingMihomoListenerPatch({ tun: { enable: true } }), false)
})
