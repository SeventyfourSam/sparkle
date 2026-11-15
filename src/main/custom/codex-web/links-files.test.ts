import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { contentHref, contentTokens, fileLocation } from '../../../shared/codex-web-links'
import { projectPath, serveProjectFile } from './files'
import {
  pageTurns,
  shiftHistoryPages,
  type HistoryPage
} from '../../../renderer/src/custom/codex-web/history-window'
import { visibleNarrative } from '../../../shared/codex-web-history'

test('content links recognize URLs, Windows and relative paths, line/column suffixes and punctuation', () => {
  assert.deepEqual(fileLocation('D:\\project\\src\\main.ts:42:5'), {
    path: 'D:\\project\\src\\main.ts',
    line: 42,
    column: 5
  })
  assert.deepEqual(fileLocation('./docs/readme.md#L12'), {
    path: './docs/readme.md',
    line: 12,
    column: undefined
  })
  const text =
    '查看 https://example.test/a?q=one。文件 src/main.ts:42:5 和 ../docs/readme.md，目录 ./src/。'
  assert.deepEqual(
    contentTokens(text).map((token) => token.value),
    ['https://example.test/a?q=one', 'src/main.ts:42:5', '../docs/readme.md', './src/']
  )
  assert.equal(contentHref('javascript:alert(1)'), undefined)
  assert.equal(contentHref('data:text/html,test'), undefined)
  assert.deepEqual(
    contentTokens('查看 "D:\\my project\\read me.txt:2" 和 "./docs/read me.md"').map(
      (token) => token.value
    ),
    ['D:\\my project\\read me.txt:2', './docs/read me.md']
  )
  const href = contentHref('docs/read%20me.md:7', {
    instanceId: 'i',
    threadId: 't',
    cwd: 'D:/project/src'
  })!
  const query = new URL(href, 'http://localhost').searchParams
  assert.equal(query.get('path'), 'docs/read me.md')
  assert.equal(query.get('line'), '7')
  assert.equal(query.get('base'), 'D:/project/src')
})

test('project file routes serve read-only previews, raw images and downloads while enforcing the project boundary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sparkle-files-'))
  const root = join(dir, 'project')
  await mkdir(join(root, 'nested'), { recursive: true })
  await writeFile(join(root, 'nested', 'read me.ts'), 'one\ntwo\nthree')
  await writeFile(join(root, 'large.txt'), 'a'.repeat(600000))
  await writeFile(join(root, 'picture.png'), Buffer.from([137, 80, 78, 71]))
  await writeFile(join(root, 'page.html'), '<script>alert(1)</script>')
  await writeFile(join(root, 'binary.dat'), Buffer.from([0, 1, 2, 3]))
  await writeFile(join(dir, 'outside.txt'), 'outside')
  const server = createServer((req, res) => {
    void serveProjectFile(req, res, root, new URL(req.url!, 'http://localhost').searchParams)
  })
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done)
  })
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const request = (path: string, mode = '', working?: string) =>
    fetch(`${base}/?${new URLSearchParams({ path, mode, ...(working ? { base: working } : {}) })}`)
  try {
    assert.equal(
      (await (await request('read me.ts', '', join(root, 'nested'))).json()).text,
      'one\ntwo\nthree'
    )
    assert.equal((await (await request('./large.txt')).json()).truncated, true)
    assert.equal((await (await request('./binary.dat')).json()).kind, 'download')
    assert.equal((await (await request('./picture.png')).json()).kind, 'image')
    assert.equal((await request('./picture.png', 'raw')).headers.get('content-type'), 'image/png')
    const html = await request('./page.html', 'raw')
    assert.equal(html.headers.get('content-type'), 'application/octet-stream')
    assert.match(html.headers.get('content-disposition')!, /attachment/)
    assert.equal(await html.text(), '<script>alert(1)</script>')
    assert.equal((await request('../outside.txt')).status, 403)
    assert.equal((await request(join(dir, 'outside.txt'))).status, 403)
    assert.equal((await request('./missing.txt')).status, 404)
    const rootDirectory = await (await request(root)).json()
    assert.equal(rootDirectory.kind, 'directory')
    assert.equal(rootDirectory.parent, null)
    assert.equal((await (await request('./nested/')).json()).parent, await realpath(root))
    try {
      await symlink(dir, join(root, 'escape'), 'junction')
      await assert.rejects(projectPath(root, './escape/outside.txt'), /项目内/)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    }
  } finally {
    await new Promise<void>((done) => {
      server.close(() => done())
    })
    await rm(dir, { recursive: true, force: true })
  }
})

test('bidirectional render windows keep a bounded page buffer and twenty messages without retaining discarded pages', () => {
  const page = (start: number): HistoryPage => ({
    data: [
      {
        id: 'turn',
        items: Array.from({ length: 10 }, (_, i) => ({
          id: `m${start + i}`,
          type: 'agentMessage',
          text: `message ${start + i}`
        }))
      }
    ],
    olderCursor: `old${start}`,
    newerCursor: `new${start}`
  })
  let pages = [page(90)]
  for (let start = 80; start >= 0; start -= 10) {
    pages = shiftHistoryPages(pages, page(start), 'older')
    assert.ok(pages.length <= 3)
    assert.ok(
      pageTurns(pages)
        .flatMap((turn) => turn.items)
        .filter(visibleNarrative).length <= 20
    )
  }
  assert.equal(pageTurns(pages)[0].items[0].id, 'm0')
  for (let start = 20; start <= 90; start += 10)
    pages = shiftHistoryPages(pages, page(start), 'newer')
  const items = pageTurns(pages,10)[0].items
  assert.equal(items[0].id, 'm80')
  assert.equal(items.at(-1).id, 'm99')
})
