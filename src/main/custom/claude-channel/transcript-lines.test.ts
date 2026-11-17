import assert from 'node:assert/strict'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { transcriptLines, type TranscriptLine } from './transcript-lines'

test('streaming transcript lines cross chunk boundaries and oversized metadata without losing neighbouring rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sparkle transcript chunks '))
  const path = join(directory, 'session.jsonl')
  const first = Buffer.from(JSON.stringify({ text: 'a'.repeat(1024 * 1024 - 15) + '中文' }) + '\n')
  const oversized = Buffer.from(
    JSON.stringify({ type: 'api-request-blob', data: 'b'.repeat(5 * 1024 * 1024) }) + '\n'
  )
  const last = Buffer.from('{"text":"last"}\n')
  const data = Buffer.concat([first, oversized, last, Buffer.from('{"unfinished":')])
  await writeFile(path, data)
  const handle = await open(path, 'r')
  try {
    const rows: TranscriptLine[] = []
    for await (const line of transcriptLines(handle, 0, data.length, true)) rows.push(line)
    assert.equal(rows.length, 3)
    assert.deepEqual(
      rows.map((row) => [row.start, row.end]),
      [
        [0, first.length],
        [first.length, first.length + oversized.length],
        [first.length + oversized.length, first.length + oversized.length + last.length]
      ]
    )
    assert.equal(rows[0].bytes?.toString(), first.toString().trimEnd())
    assert.equal(rows[1].bytes, undefined)
    assert.equal(rows[2].bytes?.toString(), '{"text":"last"}')
    const reverse: TranscriptLine[] = []
    for await (const line of transcriptLines(handle, 0, data.length, false)) reverse.push(line)
    assert.deepEqual(reverse, [...rows].reverse())
    const middle: TranscriptLine[] = []
    for await (const line of transcriptLines(handle, rows[1].start, rows[1].end, false))
      middle.push(line)
    assert.deepEqual(middle, [rows[1]])
  } finally {
    await handle.close()
    await rm(directory, { recursive: true, force: true })
  }
})
