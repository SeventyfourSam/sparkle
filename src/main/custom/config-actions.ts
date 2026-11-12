import { deepMerge } from '../utils/merge'
import { defaultControledMihomoConfig } from '../utils/template'
import {
  getAppConfig,
  getProfileConfig,
  getProfileItem,
  getOverride,
  getOverrideConfig,
  setOverride,
  setOverrideConfig,
  addOverrideItem,
  updateOverrideItem,
  removeOverrideItem
} from '../config'
import { applyConfigurationUnlocked, prepareCheckedProfile } from './config-application'
import { withConfigTransaction } from './config-transaction'
import { overrideRevision } from './override-engine'

async function selectedRevision(): Promise<string> {
  const { current } = await getProfileConfig()
  const { override = [] } = (await getProfileItem(current)) || {}
  const { items = [] } = await getOverrideConfig()
  const ids = [
    ...new Set(
      items
        .filter((item) => item.global)
        .map((item) => item.id)
        .concat(override)
    )
  ].filter((id) => items.some((item) => item.id === id))
  return JSON.stringify(
    await Promise.all(
      ids.map(async (id) => {
        const item = items.find((item) => item.id === id)
        return [
          id,
          item?.ext,
          overrideRevision(item?.ext || 'js', await getOverride(id, item?.ext || 'js'))
        ]
      })
    )
  )
}

async function editOverrides(edit: () => Promise<void>, editedId?: string): Promise<void> {
  return withConfigTransaction(async () => {
    const before = await selectedRevision()
    await edit()
    const after = await selectedRevision()
    const selected = JSON.parse(after) as [string, string, string][]
    if (before !== after || (editedId && selected.some(([id]) => id === editedId))) {
      await applyConfigurationUnlocked()
    }
  })
}

// Source files are editable drafts. Only the validated runtime snapshot is ever
// committed to work/config.yaml; failures leave the draft available for repair.
export const saveOverride = (id: string, ext: 'js' | 'yaml', content: string): Promise<void> =>
  editOverrides(() => setOverride(id, ext, content), id)

export const saveOverrideConfig = (config: OverrideConfig): Promise<void> =>
  editOverrides(() => setOverrideConfig(config))

export const saveOverrideItem = (item: OverrideItem): Promise<void> =>
  editOverrides(() => updateOverrideItem(item))

export const createOverrideItem = (item: Partial<OverrideItem>): Promise<void> =>
  editOverrides(() => addOverrideItem(item))

export const deleteOverrideItem = (id: string): Promise<void> =>
  editOverrides(() => removeOverrideItem(id))

export async function applyControlledPatch(
  patch: Partial<MihomoConfig>,
  read: () => Promise<Partial<MihomoConfig>>,
  save: (config: Partial<MihomoConfig>) => Promise<void>
): Promise<void> {
  return withConfigTransaction(async () => {
    const previous = structuredClone(await read())
    const next = structuredClone(previous)
    const { controlDns = true, controlSniff = true } = await getAppConfig()
    if (!controlDns) {
      delete next.dns
      delete next.hosts
    } else if (next.dns?.ipv6 === undefined) {
      next.dns = structuredClone(defaultControledMihomoConfig.dns)
    }
    if (!controlSniff) delete next.sniffer
    else if (!next.sniffer) next.sniffer = structuredClone(defaultControledMihomoConfig.sniffer)
    for (const key of ['nameserver-policy', 'proxy-server-nameserver-policy'] as const) {
      if (patch.dns?.[key]) {
        next.dns ??= {}
        next.dns[key] = structuredClone(patch.dns[key])
      }
    }
    if (patch.dns?.['use-hosts']) next.hosts = patch.hosts
    const controlledConfig = deepMerge(next, patch)
    // No source writes, DNS lease changes, or runtime writes before preflight.
    const candidate = await prepareCheckedProfile({ controlledConfig })
    try {
      await save(controlledConfig)
      await applyConfigurationUnlocked(false, candidate, () => save(previous))
    } catch (error) {
      await save(previous)
      throw error
    }
  })
}
