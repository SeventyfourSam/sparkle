import type { CodexRecord } from '../../../shared/codex-web'
import type { CodexWebCommand } from '../../../shared/codex-web-commands'

export async function executeWebCommand(
  command: CodexWebCommand,
  threadId: string,
  turnId: unknown,
  call: (method: string, params: CodexRecord) => Promise<CodexRecord>
): Promise<CodexRecord> {
  if (command.name === 'goal') {
    if (command.operation === 'get')
      return { webCommand: { name: 'goal', ...(await call('thread/goal/get', { threadId })) } }
    if (command.operation === 'clear') {
      await call('thread/goal/clear', { threadId, origin: 'user' })
      return { webCommand: { name: 'goal', goal: null } }
    }
    const params: CodexRecord = { threadId, origin: 'user' }
    if (command.objective !== undefined) params.objective = command.objective
    if (command.status !== undefined) params.status = command.status
    if (command.tokenBudget !== undefined) params.tokenBudget = command.tokenBudget
    return { webCommand: { name: 'goal', ...(await call('thread/goal/set', params)) } }
  }
  if (command.name === 'compact') await call('thread/compact/start', { threadId })
  if (command.name === 'stop') {
    if (typeof turnId !== 'string' || !turnId) throw new Error('当前没有运行中的任务。')
    await call('turn/interrupt', { threadId, turnId })
  }
  return { webCommand: { name: command.name } }
}
