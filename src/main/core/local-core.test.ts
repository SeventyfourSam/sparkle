import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { promisify } from 'node:util'
import { importLocalCore } from './local-core'

const execFileAsync = promisify(execFile)
const posixOnly = { skip: process.platform === 'win32' }
const versionScript = (version: string): string => `#!/bin/sh\nprintf 'Mihomo ${version}\\n'\n`

async function fixture(t: TestContext): Promise<{ source: string; storage: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sparkle-local-core-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const sourceDir = path.join(directory, '自编译 内核')
  await mkdir(sourceDir)
  return { source: path.join(sourceDir, 'custom mihomo'), storage: path.join(directory, 'cores') }
}

test(
  'imports an independent executable and survives source modification and deletion',
  posixOnly,
  async (t) => {
    const { source, storage } = await fixture(t)
    const contents = versionScript('test-1')
    await writeFile(source, contents, { mode: 0o644 })

    const imported = await importLocalCore(source, storage)
    assert.match(path.relative(await realpath(storage), imported), /^local-[A-Za-z0-9]+\/mihomo$/)
    assert.equal((await lstat(imported)).isSymbolicLink(), false)
    assert.equal(await readFile(imported, 'utf8'), contents)
    assert.equal((await lstat(imported)).mode & 0o7777, 0o500)
    assert.equal((await lstat(path.dirname(imported))).mode & 0o777, 0o700)
    assert.equal((await lstat(storage)).mode & 0o777, 0o700)

    await writeFile(source, versionScript('replaced'))
    assert.equal(await readFile(imported, 'utf8'), contents)
    await rm(source)
    assert.equal((await execFileAsync(imported, ['-v'])).stdout.trim(), 'Mihomo test-1')
    assert.equal(await importLocalCore(imported, storage), imported)
    assert.equal((await readdir(storage)).length, 1)
  }
)

test('symlink selections are copied, not linked back to the source', posixOnly, async (t) => {
  const { source, storage } = await fixture(t)
  await writeFile(source, versionScript('symlink'))
  const link = `${source}-link`
  await symlink(source, link)
  const imported = await importLocalCore(link, storage)
  await rm(link)
  await rm(source)
  assert.equal((await lstat(imported)).isSymbolicLink(), false)
  assert.equal((await execFileAsync(imported, ['-v'])).stdout.trim(), 'Mihomo symlink')
})

test(
  'reimport creates a new copy without replacing the previous executable',
  posixOnly,
  async (t) => {
    const { source, storage } = await fixture(t)
    await writeFile(source, versionScript('old'))
    const previous = await importLocalCore(source, storage)
    await writeFile(source, versionScript('new'))
    const current = await importLocalCore(source, storage)
    assert.notEqual(previous, current)
    assert.equal((await execFileAsync(previous, ['-v'])).stdout.trim(), 'Mihomo old')
    assert.equal((await execFileAsync(current, ['-v'])).stdout.trim(), 'Mihomo new')
    assert.equal((await readdir(storage)).length, 2)
  }
)

test(
  'failed validation removes staging files and preserves existing imports',
  posixOnly,
  async (t) => {
    const { source, storage } = await fixture(t)
    await writeFile(source, versionScript('working'))
    const previous = await importLocalCore(source, storage)
    for (const invalid of ["#!/bin/sh\nprintf 'different program\\n'\n", '#!/bin/sh\nexit 1\n']) {
      await writeFile(source, invalid)
      await assert.rejects(importLocalCore(source, storage), /导入本地内核失败/)
      assert.deepEqual(await readdir(storage), [path.basename(path.dirname(previous))])
      assert.equal((await execFileAsync(previous, ['-v'])).stdout.trim(), 'Mihomo working')
    }
  }
)

test('a hanging version check times out and leaves no partial import', posixOnly, async (t) => {
  const { source, storage } = await fixture(t)
  await writeFile(source, '#!/bin/sh\nexec /bin/sleep 30\n')
  await assert.rejects(importLocalCore(source, storage), /导入本地内核失败/)
  assert.deepEqual(await readdir(storage), [])
})

test('rejects relative paths, missing files, directories and empty files', async (t) => {
  const { source, storage } = await fixture(t)
  await assert.rejects(importLocalCore('relative/mihomo', storage), /绝对路径/)
  await assert.rejects(importLocalCore(source, storage), /ENOENT/)
  await assert.rejects(importLocalCore(path.dirname(source), storage), /非空/)
  await writeFile(source, '')
  await assert.rejects(importLocalCore(source, storage), /非空/)
})

test('does not preserve writable or setuid permission bits', posixOnly, async (t) => {
  const { source, storage } = await fixture(t)
  await writeFile(source, versionScript('permissions'))
  await chmod(source, 0o4755)
  const imported = await importLocalCore(source, storage)
  assert.equal((await lstat(imported)).mode & 0o7777, 0o500)
})
