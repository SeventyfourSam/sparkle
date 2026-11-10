import { version } from '@renderer/utils/init'
import { isCustomBuild } from '../../../shared/custom-build'

export function allowOfficialAppUpdates(): boolean {
  return !isCustomBuild(version)
}
export const showLegacyMacDnsControl = false
