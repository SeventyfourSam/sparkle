import { Chip } from '@heroui/react'
import useSWR from 'swr'

async function fetchStatuses(): Promise<Record<string, OverrideStatus>> {
  const result = await window.electron.ipcRenderer.invoke('getOverrideStatuses')
  if (result && 'invokeError' in result) throw new Error(result.invokeError)
  return result
}

const presentation = {
  active: { label: '已生效', color: 'success' },
  inactive: { label: '未生效', color: 'primary' },
  error: { label: '配置错误', color: 'danger' },
  checking: { label: '检查中', color: 'default' }
} as const

export default function OverrideStatusChip({ id }: { id: string }): React.ReactElement {
  // All cards share one request. Polling also observes edits made outside Sparkle.
  const { data, error } = useSWR('getOverrideStatuses', fetchStatuses, { refreshInterval: 2000 })
  const status = data?.[id]
  const { label, color } = presentation[status?.state ?? 'checking']
  return (
    <Chip
      size="sm"
      data-color={color}
      variant="tertiary"
      data-dot="true"
      className="ml-2"
      title={status?.message ?? (error ? '状态读取失败，等待重试' : '正在读取覆写状态')}
      aria-label={`${label}：${status?.message ?? '正在读取覆写状态'}`}
    >
      <span className="chip__dot" aria-hidden="true" />
      <Chip.Label>{label}</Chip.Label>
    </Chip>
  )
}
