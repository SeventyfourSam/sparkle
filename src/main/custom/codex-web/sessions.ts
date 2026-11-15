import { isAbsolute } from 'node:path'
import type { CodexRecord, CodexSessionPage } from '../../../shared/codex-web'

export function sessionId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 200 || /[\s/\\]/.test(value))
    throw new Error('会话 ID 无效')
  return value
}

export async function readSessions(
  value: CodexRecord,
  call: (method: string, params: CodexRecord) => Promise<CodexRecord>
): Promise<CodexSessionPage> {
  const params: CodexRecord = {
    limit: 20,
    sortKey: 'updated_at',
    sortDirection: 'desc',
    archived: false,
    modelProviders: []
  }
  if (value.cwd !== undefined) {
    if (typeof value.cwd !== 'string' || value.cwd.length > 4096 || !isAbsolute(value.cwd))
      throw new Error('工作目录必须是绝对路径')
    params.cwd = value.cwd
  }
  if (value.cursor !== undefined && value.cursor !== null) {
    if (typeof value.cursor !== 'string' || !value.cursor || value.cursor.length > 8192)
      throw new Error('会话分页游标无效')
    params.cursor = value.cursor
  }
  try {
    const result = await call('thread/list', params)
    if (!Array.isArray(result.data)) throw new Error('Codex 没有返回会话列表')
    return {
      data: result.data.slice(0, 20).map((thread: CodexRecord) => ({
        id: sessionId(thread.id),
        name: String(thread.name || '').slice(0, 500),
        preview: String(thread.preview || '').slice(0, 1000),
        cwd: String(thread.cwd || '').slice(0, 4096),
        updatedAt: Number(thread.updatedAt) || 0
      })),
      nextCursor:
        typeof result.nextCursor === 'string' &&
        result.nextCursor &&
        result.nextCursor !== value.cursor
          ? result.nextCursor
          : null
    }
  } catch (error) {
    if (/method not found|unknown variant|unknown method/i.test(String(error)))
      throw new Error('当前 Codex 不支持历史会话列表，请更新 Codex 后重试')
    throw error
  }
}
