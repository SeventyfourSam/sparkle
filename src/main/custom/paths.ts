import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { getAppConfigSync } from '../config/app'
import { dataDir } from '../utils/dirs'
import { compareMihomoVersions } from '../../shared/mihomo-release'

export function localCoreDir(): string {
  return path.join(dataDir(), 'cores')
}

export function resolveCustomCorePath(bundledPath: string): string {
  const { customMihomo } = getAppConfigSync()
  if (!customMihomo?.path || !existsSync(customMihomo.path)) return bundledPath
  let bundledVersion = ''
  try {
    bundledVersion = readFileSync(
      path.join(path.dirname(bundledPath), 'mihomo-version.txt'),
      'utf8'
    ).trim()
  } catch {
    // Older bundles did not include a version manifest.
  }
  return compareMihomoVersions(customMihomo.version, bundledVersion) >= 0
    ? customMihomo.path
    : bundledPath
}
