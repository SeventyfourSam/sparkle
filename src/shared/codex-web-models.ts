import type { CodexRecord } from './codex-web'

export interface CodexWebModel {
  model: string
  displayName: string
  description: string
  defaultReasoningEffort: string
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[]
}

// ThreadSettings uses `effort`; thread metadata uses `reasoningEffort`.
export function threadSettingsPatch(settings: CodexRecord): CodexRecord {
  const patch: CodexRecord = {}
  for (const [source, target] of [
    ['model', 'model'],
    ['effort', 'reasoningEffort'],
    ['modelProvider', 'modelProvider'],
    ['serviceTier', 'serviceTier'],
    ['cwd', 'cwd'],
    ['approvalPolicy', 'approvalPolicy'],
    ['sandboxPolicy', 'sandbox'],
    ['activePermissionProfile', 'activePermissionProfile']
  ])
    if (Object.hasOwn(settings, source)) patch[target] = settings[source]
  return patch
}
