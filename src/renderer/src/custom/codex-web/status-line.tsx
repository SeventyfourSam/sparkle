import type { JSX } from 'react'
import type { CodexRecord } from '../../../../shared/codex-web'
import type { Conversation } from './state'

const number = (value: number): string => Intl.NumberFormat('zh-CN').format(value)
export function contextUsage(usage?: CodexRecord): string | undefined {
  const window = usage?.modelContextWindow
  const used = usage?.last?.totalTokens
  if (
    typeof window !== 'number' ||
    !Number.isFinite(window) ||
    window <= 0 ||
    typeof used !== 'number' ||
    !Number.isFinite(used) ||
    used < 0
  )
    return undefined
  return `${Math.min(100, Math.max(0, Math.round((used / window) * 100)))}% · ${number(used)} / ${number(window)}`
}

export function SessionStatus({
  thread,
  conversation,
  expanded,
  onToggle,
  onEditSettings,
  settingsDisabled
}: {
  thread?: CodexRecord
  conversation: Conversation
  expanded: boolean
  onToggle: () => void
  onEditSettings: () => void
  settingsDisabled: boolean
}): JSX.Element {
  const usage = conversation.tokenUsage
  const context = contextUsage(usage)
  const goal = conversation.goal
  const goalStatus =
    (
      {
        active: '进行中',
        paused: '已暂停',
        blocked: '等待处理',
        usageLimited: '额度受限',
        budgetLimited: '预算已用完',
        complete: '已完成'
      } as Record<string, string>
    )[goal?.status] || goal?.status
  const rows: [string, unknown][] = [
    ['模型', thread?.model],
    ['推理强度', thread?.reasoningEffort],
    ['提供商', thread?.modelProvider],
    ['服务等级', thread?.serviceTier],
    ['工作目录', thread?.cwd],
    ['会话 ID', thread?.id],
    ['Git 分支（会话记录）', thread?.gitInfo?.branch],
    ['上下文 token 占比估算', context],
    ['累计输入 token', usage?.total?.inputTokens],
    ['累计输出 token', usage?.total?.outputTokens],
    ['累计缓存命中 token', usage?.total?.cachedInputTokens],
    ['累计 token', usage?.total?.totalTokens],
    ['权限', thread?.activePermissionProfile?.id || thread?.sandbox?.type],
    ['审批策略', typeof thread?.approvalPolicy === 'string' ? thread.approvalPolicy : undefined]
  ]
  const rates = conversation.rateLimits?.rateLimits
  for (const [key, label] of [
    ['primary', '主要额度'],
    ['secondary', '次要额度']
  ] as const) {
    const rate = rates?.[key]
    if (typeof rate?.usedPercent === 'number') {
      const minutes = rate.windowDurationMins
      const windowLabel =
        typeof minutes === 'number'
          ? minutes >= 1440
            ? `${minutes / 1440} 天`
            : `${minutes / 60} 小时`
          : label
      rows.push([
        `${windowLabel}额度剩余`,
        `${Math.max(0, Math.min(100, 100 - rate.usedPercent))}%`
      ])
    }
  }
  return (
    <div className="session-status">
      <div className="session-status-top">
        <button
          type="button"
          className="session-model-button"
          aria-label="修改模型与推理强度"
          disabled={settingsDisabled}
          onClick={onEditSettings}
        >
          <span className="session-model-name">
            {thread?.model || 'Codex'}
            {thread?.reasoningEffort ? ` · ${thread.reasoningEffort}` : ''}
          </span>
          <span aria-hidden="true">⌄</span>
        </button>
        <button
          type="button"
          className="session-status-toggle"
          aria-expanded={expanded}
          aria-controls="session-status-details"
          onClick={onToggle}
        >
          <span>
            {context
              ? `上下文 ${context.split(' · ')[0]}`
              : usage?.total?.totalTokens !== undefined
                ? `${number(usage.total.totalTokens)} tokens`
                : '会话状态'}{' '}
            <span aria-hidden="true">{expanded ? '⌃' : '⌄'}</span>
          </span>
        </button>
      </div>
      {expanded && (
        <div
          className="session-status-details"
          id="session-status-details"
          aria-label="会话状态详情"
        >
          <div className="session-goal">
            <strong>目标{goalStatus ? ` · ${goalStatus}` : ''}</strong>
            <p>
              {goal?.objective ||
                (goal === null
                  ? '尚未设置目标，输入 /goal <目标> 开始。'
                  : '输入 /goal 获取当前目标。')}
            </p>
            {goal && (
              <span>
                {number(goal.tokensUsed || 0)}
                {goal.tokenBudget != null ? ` / ${number(goal.tokenBudget)}` : ''} tokens ·{' '}
                {Math.floor((goal.timeUsedSeconds || 0) / 60)} 分钟
              </span>
            )}
          </div>
          <dl>
            {rows
              .filter(([, value]) => value !== undefined && value !== null && value !== '')
              .map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{typeof value === 'number' ? number(value) : String(value)}</dd>
                </div>
              ))}
          </dl>
          <p className="status-note">
            显示 Codex 已提供的会话数据；终端 statusline 的完整选项和自定义数值尚未同步。
          </p>
        </div>
      )}
    </div>
  )
}
