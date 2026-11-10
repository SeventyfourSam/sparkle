import { writeFile } from 'node:fs/promises'
import { ensureLocalCorePermission, importLocalCore } from '../core/local-core'
import { controledMihomoConfigPath } from '../utils/dirs'
import { stringifyYaml } from '../utils/yaml'
import { prepareMihomoSystemDnsAppPatch } from '../sys/mihomo-system-dns'
import { localCoreDir } from './paths'

export function customizeAppConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    core: config.core === 'mihomo-alpha' ? 'mihomo' : config.core,
    updateChannel: 'stable'
  }
}

/** Validate and authorize before any caller can persist a new core or release DNS. */
export async function prepareCustomAppPatch(
  patch: Partial<AppConfig>,
  current: AppConfig
): Promise<Partial<AppConfig>> {
  const nextCore = patch.core ?? current.core
  if (patch.systemCorePath || (nextCore === 'system' && (patch.core || patch.corePermissionMode))) {
    const imported = await importLocalCore(
      patch.systemCorePath || current.systemCorePath || '',
      localCoreDir()
    )
    if (
      nextCore === 'system' &&
      (patch.corePermissionMode ?? current.corePermissionMode) !== 'service'
    ) {
      await ensureLocalCorePermission(imported)
    }
    patch = { ...patch, systemCorePath: imported }
  }
  return prepareMihomoSystemDnsAppPatch(patch, current)
}

export async function migrateCustomControlledConfig(config: Partial<MihomoConfig>): Promise<void> {
  if (config.dns && config.dns.listen === undefined) {
    // An explicit empty value prevents subscriptions from enabling a DNS listener.
    config.dns = { ...config.dns, listen: '' }
    await writeFile(controledMihomoConfigPath(), stringifyYaml(config), 'utf8')
  }
}
