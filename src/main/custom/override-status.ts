import { getOverride, getOverrideConfig } from '../config/override'
import { checkOverrideSyntax, overrideRevision } from './override-engine'

export interface AppliedOverride {
  id: string
  revision: string
}

let applied: AppliedOverride[] = []
let running = false
let checking = false
const failures = new Map<string, { revision: string; message: string }>()

export function setOverridesChecking(value: boolean): void {
  checking = value
}

export function reportOverrideError(id: string, revision: string, error: unknown): void {
  failures.set(id, { revision, message: String(error) })
}

export function clearOverrideError(id: string): void {
  failures.delete(id)
}

export function markOverridesApplied(overrides: AppliedOverride[]): void {
  applied = overrides
  running = true
  for (const { id, revision } of overrides) {
    if (failures.get(id)?.revision === revision) failures.delete(id)
  }
}

export function markOverridesStopped(): void {
  running = false
}

export async function getOverrideStatuses(): Promise<Record<string, OverrideStatus>> {
  const { items = [] } = await getOverrideConfig()
  const entries = await Promise.all(
    items.map(async (item): Promise<[string, OverrideStatus]> => {
      const previous = applied.find((entry) => entry.id === item.id)
      try {
        const content = await getOverride(item.id, item.ext)
        const revision = overrideRevision(item.ext, content)
        checkOverrideSyntax(item.ext, content)
        const failure = failures.get(item.id)
        if (failure?.revision === revision) throw new Error(failure.message)
        if (checking) return [item.id, { state: 'checking', message: '正在检查待应用配置' }]
        if (running && previous?.revision === revision) {
          return [item.id, { state: 'active', message: '此版本已随当前完整配置成功加载' }]
        }
        return [
          item.id,
          {
            state: 'inactive',
            message:
              running && previous
                ? '语法检查通过，修改尚未应用；当前仍运行上次成功版本'
                : '语法检查通过，未加载到当前核心；脚本运行结果会在应用时检查'
          }
        ]
      } catch (error) {
        return [
          item.id,
          {
            state: 'error',
            message: `${error}${running && previous ? '\n当前仍运行上次成功版本' : ''}`
          }
        ]
      }
    })
  )
  return Object.fromEntries(entries)
}
