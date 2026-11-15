import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { readSessions, sessionId } from './sessions'
import type { CodexRecord } from '../../../shared/codex-web'

test('saved session listing requests bounded project pages and never forwards rollout contents', async () => {
  const calls: CodexRecord[] = []
  const result = await readSessions(
    { cwd: tmpdir(), cursor: 'previous' },
    async (method, params) => {
      calls.push({ method, params })
      return {
        data: Array.from({ length: 30 }, (_, i) => ({
          id: `saved-${i}`,
          name: 'Title',
          preview: 'a'.repeat(2000),
          cwd: tmpdir(),
          updatedAt: i,
          turns: [{ items: [{ text: 'large rollout' }] }],
          path: 'private/rollout.jsonl'
        })),
        nextCursor: 'next'
      }
    }
  )
  assert.deepEqual(calls, [
    {
      method: 'thread/list',
      params: {
        limit: 20,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        archived: false,
        modelProviders: [],
        cwd: tmpdir(),
        cursor: 'previous'
      }
    }
  ])
  assert.equal(result.data.length, 20)
  assert.equal(result.data[0].preview.length, 1000)
  assert.equal('turns' in result.data[0], false)
  assert.equal('path' in result.data[0], false)
  assert.equal(result.nextCursor, 'next')
})

test('session inputs reject invalid paths and cursors before calling Codex', async () => {
  const call = async (): Promise<never> => {
    throw new Error('should not be called')
  }
  await assert.rejects(readSessions({ cwd: 'relative' }, call), /绝对路径/)
  await assert.rejects(readSessions({ cursor: 1 }, call), /游标/)
  assert.throws(() => sessionId('../rollout.jsonl'), /ID 无效/)
  assert.throws(() => sessionId('two ids'), /ID 无效/)
  assert.equal(sessionId('saved-session'), 'saved-session')
  const result = await readSessions({ cursor: 'same' }, async () => ({
    data: [],
    nextCursor: 'same'
  }))
  assert.equal(result.nextCursor, null)
  await assert.rejects(
    readSessions({}, async () => {
      throw new Error('Method not found')
    }),
    /更新 Codex/
  )
})
