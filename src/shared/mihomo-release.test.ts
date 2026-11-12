import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import AdmZip from 'adm-zip'
import {
  downloadMihomoRelease,
  getMihomoRelease,
  MIHOMO_RELEASE_API,
  requestReleaseFile,
  selectMihomoRelease,
  verifyMihomoChecksum
} from './mihomo-release'

const version = 'v1.19.33-custom.2'
const windowsAsset = `mihomo-windows-amd64-${version}.zip`
const macAsset = `mihomo-darwin-arm64-${version}.gz`
const metadata = {
  tag_name: version,
  draft: false,
  prerelease: false,
  assets: [windowsAsset, macAsset, 'SHA256SUMS'].map((name) => ({ name }))
}
const checksum = (data: Buffer, name: string): string =>
  `${createHash('sha256').update(data).digest('hex')}  ${name}\n`

test('release downloads authenticate only the GitHub API, never assets or lookalike hosts', async (t) => {
  const previous = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN }
  t.after(() => {
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN'] as const) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  })
  const requests: { url: string; headers: Headers }[] = []
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requests.push({ url, headers: new Headers(init.headers) })
    return new Response('download')
  })
  process.env.GH_TOKEN = 'test-actions-token'
  process.env.GITHUB_TOKEN = 'test-fallback-token'
  await requestReleaseFile(MIHOMO_RELEASE_API)
  assert.equal(requests.at(-1)?.headers.get('authorization'), 'Bearer test-actions-token')
  for (const url of [
    `https://github.com/SeventyfourSam/mihomo/releases/download/${version}/${macAsset}`,
    'https://api.github.com.example.com/releases',
    'http://api.github.com/releases'
  ]) {
    await requestReleaseFile(url)
    assert.equal(requests.at(-1)?.headers.has('authorization'), false)
  }
  delete process.env.GH_TOKEN
  await requestReleaseFile(MIHOMO_RELEASE_API)
  assert.equal(requests.at(-1)?.headers.get('authorization'), 'Bearer test-fallback-token')
  delete process.env.GITHUB_TOKEN
  await requestReleaseFile(MIHOMO_RELEASE_API)
  assert.equal(requests.at(-1)?.headers.has('authorization'), false)
})

test('GitHub API failures preserve the diagnostic message', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          message: 'API rate limit exceeded'
        }),
        { status: 403 }
      )
  )
  await assert.rejects(requestReleaseFile(MIHOMO_RELEASE_API), /HTTP 403.*API rate limit exceeded/)
})

test('uses the custom stable Release API and the published Windows/macOS asset names', async () => {
  const release = await getMihomoRelease('win32', 'x64', async (url) => {
    assert.equal(url, MIHOMO_RELEASE_API)
    return Buffer.from(JSON.stringify(metadata))
  })
  assert.equal(release.assetName, windowsAsset)
  assert.equal(release.executableName, 'mihomo-windows-amd64.exe')
  assert.match(release.downloadURL, /github.com\/SeventyfourSam\/mihomo\/releases\/download\//)
  assert.equal(selectMihomoRelease(metadata, 'darwin', 'arm64').assetName, macAsset)
})

test('rejects upstream versions, prereleases, unsupported platforms and incomplete releases', () => {
  for (const data of [
    null,
    {},
    { ...metadata, tag_name: 'v1.19.33' },
    { ...metadata, prerelease: true },
    { ...metadata, draft: true },
    { ...metadata, assets: [] }
  ]) {
    assert.throws(() => selectMihomoRelease(data, 'win32', 'x64'))
  }
  for (const [platform, arch] of [
    ['linux', 'x64'],
    ['win32', 'arm64'],
    ['darwin', 'x64']
  ]) {
    assert.throws(() => selectMihomoRelease(metadata, platform, arch), /尚未提供/)
  }
})

test('verifies the exact archive before extracting either zip or gzip', async () => {
  const executable = Buffer.from('test executable')
  const zip = new AdmZip()
  zip.addFile('mihomo-windows-amd64.exe', executable)
  for (const [platform, arch, archive] of [
    ['win32', 'x64', zip.toBuffer()],
    ['darwin', 'arm64', gzipSync(executable)]
  ] as const) {
    const release = selectMihomoRelease(metadata, platform, arch)
    const extracted = await downloadMihomoRelease(release, async (url) =>
      url === release.checksumURL ? Buffer.from(checksum(archive, release.assetName)) : archive
    )
    assert.deepEqual(extracted, executable)
  }
})

test('fails closed on checksum mismatch, missing checksum or unexpected zip entry', async () => {
  const release = selectMihomoRelease(metadata, 'win32', 'x64')
  assert.throws(
    () =>
      verifyMihomoChecksum(
        Buffer.from('tampered'),
        checksum(Buffer.from('original'), windowsAsset),
        windowsAsset
      ),
    /校验失败/
  )
  assert.throws(
    () =>
      verifyMihomoChecksum(
        Buffer.from('test'),
        checksum(Buffer.from('test'), macAsset),
        windowsAsset
      ),
    /缺少/
  )
  const zip = new AdmZip()
  zip.addFile('../unexpected.exe', Buffer.from('test'))
  const archive = zip.toBuffer()
  await assert.rejects(
    downloadMihomoRelease(release, async (url) =>
      url === release.checksumURL ? Buffer.from(checksum(archive, windowsAsset)) : archive
    ),
    /缺少可执行文件/
  )
})

test('can pin the bundled core to one release for all build platforms', async () => {
  const release = await getMihomoRelease(
    'win32',
    'x64',
    async (url) => {
      assert.equal(
        url,
        `https://api.github.com/repos/SeventyfourSam/mihomo/releases/tags/${version}`
      )
      return Buffer.from(JSON.stringify(metadata))
    },
    version
  )
  assert.equal(release.version, version)
})
