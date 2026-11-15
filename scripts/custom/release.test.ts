import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'
import { nextReleaseVersion, releaseArtifacts } from './release.ts'

test('release versions increase custom revisions and start at one for a new upstream version', () => {
  assert.equal(nextReleaseVersion('1.26.10', '1.26.10-custom.2', []), '1.26.10-custom.3')
  assert.equal(nextReleaseVersion('v1.26.11', '1.26.11', []), '1.26.11-custom.1')
  assert.equal(
    nextReleaseVersion('1.26.10', '1.26.10-custom.2', ['v1.26.10-custom.10', 'v1.27.0-custom.99']),
    '1.26.10-custom.11'
  )
  assert.equal(nextReleaseVersion('1.26.10', '1.26.10-custom.3', [], true), '1.26.10-custom.3')
  assert.throws(() => nextReleaseVersion('1.26.9', '1.26.10-custom.3', []))
  assert.throws(() => nextReleaseVersion('1.27.0-beta.1', '1.27.0', []))
})

test('the published update manifest names the tested version and all three platform packages', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sparkle-release-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const version = '1.26.10-custom.3'
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ version }))
  await writeFile(path.join(dir, 'changelog.md'), 'Release notes\nwith "quotes" and 中文')
  await mkdir(path.join(dir, 'dist'))
  for (const file of releaseArtifacts(version)) await writeFile(path.join(dir, 'dist', file), file)
  const generate = () =>
    execFileSync(process.execPath, [path.join(import.meta.dirname, 'release.ts'), 'manifest'], {
      cwd: dir,
      windowsHide: true,
      env: { ...process.env, VERSION: version, MIHOMO_RELEASE_VERSION: 'v1.19.33-custom.3' }
    })
  generate()
  const manifest = parse(await readFile(path.join(dir, 'latest.yml'), 'utf8'))
  assert.equal(manifest.version, version)
  assert.equal(manifest.tag, `v${version}`)
  assert.match(manifest.changelog, /with "quotes" and 中文/)
  assert.equal((await readFile(path.join(dir, 'SHA256SUMS'), 'utf8')).trim().split('\n').length, 3)
  await mkdir(path.join(dir, 'scripts', 'custom'), { recursive: true })
  await writeFile(
    path.join(dir, 'scripts', 'custom', 'release-notes.md'),
    'Custom 配置预检与热加载'
  )
  generate()
  const withCustom = parse(await readFile(path.join(dir, 'latest.yml'), 'utf8'))
  assert.match(withCustom.changelog, /Custom 配置预检与热加载/)
  assert.match(withCustom.changelog, /with "quotes" and 中文/)
  assert.equal(
    await readFile(path.join(dir, 'release-notes.md'), 'utf8'),
    `${withCustom.changelog}\n`
  )
})
