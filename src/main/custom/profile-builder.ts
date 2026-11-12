import { generateProfile, setRuntimeProfile } from '../core/factory'
import { getOverride, getOverrideConfig, getProfileItem } from '../config'
import { deepMerge } from '../utils/merge'
import { executeOverride, overrideRevision, parseOverrideYaml } from './override-engine'
import { writeAtomic } from './atomic-file'
import { clearOverrideError, reportOverrideError, type AppliedOverride } from './override-status'

export interface PreparedProfile {
  config: MihomoConfig
  yaml: string
  raw: string
  currentYaml: string
  overrideYaml: string
  current: string | undefined
  appConfig: AppConfig
  controlledConfig: Partial<MihomoConfig>
  workDir: string
  configPath: string
  overrides: AppliedOverride[]
}

export interface ProfileInputs {
  controlledConfig?: Partial<MihomoConfig>
}

export interface ProfileGeneration extends ProfileInputs {
  overrideProfile: (current: string | undefined, profile: MihomoConfig) => Promise<MihomoConfig>
  onPrepared: (profile: Omit<PreparedProfile, 'overrides'>) => void
}

let committed: PreparedProfile | undefined

export function getCommittedProfile(): PreparedProfile | undefined {
  return committed
}

export async function commitProfile(profile: PreparedProfile): Promise<void> {
  await writeAtomic(profile.configPath, profile.yaml)
  setRuntimeProfile(profile)
  committed = profile
}

export async function prepareProfile(inputs: ProfileInputs = {}): Promise<PreparedProfile> {
  let prepared: PreparedProfile | undefined
  const applied: AppliedOverride[] = []
  await generateProfile({
    ...inputs,
    onPrepared: (profile) => {
      prepared = { ...profile, overrides: applied }
    },
    overrideProfile: async (current, profile) => {
      const { items = [] } = await getOverrideConfig()
      const { override = [] } = (await getProfileItem(current)) || {}
      const ids = [
        ...new Set(
          items
            .filter((item) => item.global)
            .map((item) => item.id)
            .concat(override)
        )
      ].filter((id) => items.some((item) => item.id === id))
      // Snapshot all sources before running scripts. Never rerun them after -t.
      const sources = await Promise.all(
        ids.map(async (id) => {
          const item = items.find((entry) => entry.id === id)
          if (!item) throw new Error(`覆写不存在：${id}`)
          const content = await getOverride(id, item.ext)
          return { item, content, revision: overrideRevision(item.ext, content) }
        })
      )
      for (const { item, content, revision } of sources) {
        try {
          profile =
            item.ext === 'js'
              ? await executeOverride(profile, content, item)
              : deepMerge(profile, parseOverrideYaml(content), true)
          clearOverrideError(item.id)
          applied.push({ id: item.id, revision })
        } catch (error) {
          reportOverrideError(item.id, revision, error)
          throw new Error(`覆写「${item.name}」错误：${error}`)
        }
      }
      return profile
    }
  })
  if (!prepared) throw new Error('未生成待应用配置')
  return prepared
}
