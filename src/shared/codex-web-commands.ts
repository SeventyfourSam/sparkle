export type CodexWebCommand =
  | { name: 'help' | 'status' | 'compact' | 'stop' | 'model' | 'reasoning' }
  | {
      name: 'goal'
      operation: 'get' | 'clear' | 'set'
      objective?: string
      status?: 'active' | 'paused'
      tokenBudget?: number | null
    }

export const codexWebCommands = [
  { name: 'model', description: '修改模型与推理强度', usage: '/model 打开会话模型设置' },
  { name: 'reasoning', description: '修改推理强度', usage: '/reasoning 打开会话模型设置' },
  {
    name: 'goal',
    description: '查看或设置长期目标',
    usage: '/goal [目标]；/goal pause、resume、clear、budget <数字|off>'
  },
  { name: 'status', description: '查看会话状态', usage: '/status' },
  { name: 'compact', description: '压缩会话上下文', usage: '/compact' },
  { name: 'stop', description: '停止当前任务', usage: '/stop' },
  { name: 'help', description: '查看网页支持的命令', usage: '/help' }
] as const

export function parseCodexWebCommand(text: string): CodexWebCommand | null {
  const match = /^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim())
  if (!match) return null
  const name = match[1].toLowerCase()
  const args = (match[2] || '').trim()
  if (name === 'side' || name === 'btw')
    throw new Error('/side 需要 Codex 提供完整的旁支会话接口，网页暂不支持；这条命令不会发给模型。')
  if (name === 'goal') {
    if (!args || args === 'status') return { name, operation: 'get' }
    if (args === 'clear') return { name, operation: 'clear' }
    if (args === 'pause' || args === 'resume')
      return { name, operation: 'set', status: args === 'pause' ? 'paused' : 'active' }
    const budget = /^budget\s+(\S+)$/.exec(args)
    if (budget) {
      const value = budget[1] === 'off' ? null : Number(budget[1])
      if (value !== null && (!Number.isSafeInteger(value) || value <= 0))
        throw new Error('目标预算必须是正整数，或使用 /goal budget off 取消预算。')
      return { name, operation: 'set', tokenBudget: value }
    }
    if (
      /^(pause|resume|clear|status|budget|edit|set)(\s|$)/.test(args) &&
      !/^(edit|set)\s+\S/.test(args)
    )
      throw new Error('用法：/goal <目标>，或 /goal pause、resume、clear、budget <数字|off>。')
    const objective = args.replace(/^(edit|set)\s+/, '')
    if (objective.length > 10000) throw new Error('目标不能超过 10000 个字符。')
    return {
      name,
      operation: 'set',
      objective,
      ...(!args.startsWith('edit ') ? { status: 'active' as const } : {})
    }
  }
  if (
    name === 'help' ||
    name === 'status' ||
    name === 'compact' ||
    name === 'stop' ||
    name === 'model' ||
    name === 'reasoning'
  ) {
    if (args) throw new Error(`/${name} 不接受额外参数。`)
    return { name }
  }
  throw new Error(
    `网页暂不支持 /${name}。输入 /help 查看支持的命令；普通文本以 // 开头可保留一个 /。`
  )
}
