import { controledMihomoConfigPath } from '../utils/dirs'
import { readFile, writeFile } from 'fs/promises'
import { parseYaml, stringifyYaml } from '../utils/yaml'
import { applyControlledPatch } from '../custom/config-actions'
import { writeAtomic } from '../custom/atomic-file'
import { defaultControledMihomoConfig } from '../utils/template'
import { notifyConfigOperation } from '../resolve/webhook'
import { migrateCustomControlledConfig } from '../custom/config'

let controledMihomoConfig: Partial<MihomoConfig> // mihomo.yaml

export async function getControledMihomoConfig(force = false): Promise<Partial<MihomoConfig>> {
  if (force || !controledMihomoConfig) {
    try {
      const data = await readFile(controledMihomoConfigPath(), 'utf-8')
      controledMihomoConfig = parseYaml<Partial<MihomoConfig>>(data) || defaultControledMihomoConfig
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
      controledMihomoConfig = defaultControledMihomoConfig
      await writeFile(controledMihomoConfigPath(), stringifyYaml(controledMihomoConfig), 'utf-8')
    }
  }
  if (typeof controledMihomoConfig !== 'object')
    controledMihomoConfig = defaultControledMihomoConfig
  await migrateCustomControlledConfig(controledMihomoConfig)
  return controledMihomoConfig
}

export async function patchControledMihomoConfig(patch: Partial<MihomoConfig>): Promise<void> {
  await applyControlledPatch(patch, getControledMihomoConfig, async (config) => {
    await writeAtomic(controledMihomoConfigPath(), stringifyYaml(config))
    controledMihomoConfig = config
  })
  notifyConfigOperation('patchControledMihomoConfig', patch)
}
