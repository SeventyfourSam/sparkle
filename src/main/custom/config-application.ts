import { getAxios, mihomoConfig } from '../core/mihomoApi'
import { startCore, stopCore } from '../core/manager'
import { format } from 'node:util'
import { readFile } from 'node:fs/promises'
import { parseYaml } from '../utils/yaml'
import { patchAppConfig } from '../config'
import {
  acquireMihomoSystemDNSLease,
  prepareMihomoSystemDnsRuntimePatch,
  reconcileMihomoSystemDNSLease
} from '../sys/mihomo-system-dns'
import {
  commitProfile,
  prepareProfile,
  type PreparedProfile,
  type ProfileInputs
} from './profile-builder'
import { checkProfile } from './profile-check'
import {
  checkAppliedConfig,
  requiresCoreRestart,
  rollbackLaunchPatch,
  withConfigTransaction
} from './config-transaction'
import {
  markOverridesApplied,
  markOverridesStopped,
  reportOverrideError,
  setOverridesChecking
} from './override-status'

let applied: PreparedProfile | undefined
let running = false

export function getAppliedProfile(): PreparedProfile | undefined {
  return applied
}

export async function markProfileApplied(profile: PreparedProfile): Promise<void> {
  applied = profile
  running = true
  markOverridesApplied(profile.overrides)
}

export function markProfileStopped(): void {
  running = false
  markOverridesStopped()
}

export async function prepareCheckedProfile(inputs: ProfileInputs = {}): Promise<PreparedProfile> {
  setOverridesChecking(true)
  try {
    const candidate = await prepareProfile(inputs)
    try {
      await checkProfile(candidate)
    } catch (error) {
      // Attribute a semantic failure only when the base and settings are
      // unchanged and a single override revision is the only differing input.
      if (
        applied &&
        applied.raw === candidate.raw &&
        applied.current === candidate.current &&
        applied.workDir === candidate.workDir &&
        applied.appConfig.controlDns === candidate.appConfig.controlDns &&
        applied.appConfig.controlSniff === candidate.appConfig.controlSniff &&
        JSON.stringify(applied.controlledConfig) === JSON.stringify(candidate.controlledConfig)
      ) {
        const changed = candidate.overrides.filter(
          (entry) =>
            !applied!.overrides.some(
              (old) => old.id === entry.id && old.revision === entry.revision
            )
        )
        const oldIds = applied.overrides.map((entry) => entry.id)
        const retainedIds = candidate.overrides
          .filter((entry) => oldIds.includes(entry.id))
          .map((entry) => entry.id)
        if (changed.length === 1 && JSON.stringify(oldIds) === JSON.stringify(retainedIds)) {
          reportOverrideError(changed[0].id, changed[0].revision, error)
        }
      }
      throw error
    }
    return candidate
  } finally {
    setOverridesChecking(false)
  }
}

async function reload(profile: PreparedProfile): Promise<void> {
  await prepareMihomoSystemDnsRuntimePatch(profile.config)
  const instance = await getAxios()
  // force=true applies listener settings too. Unchanged TUN/listeners are reused
  // by Mihomo; this flag does not restart the process or close all connections.
  await instance.put('/configs?force=true', { payload: profile.yaml }, { timeout: 60_000 })
  checkAppliedConfig(profile.config, await mihomoConfig())
}

export function applyConfiguration(forceRestart = false): Promise<void> {
  return withConfigTransaction(() => applyConfigurationUnlocked(forceRestart))
}

export function recoverAppliedConfiguration(): Promise<void> {
  return withConfigTransaction(async () => {
    if (!applied) return applyConfigurationUnlocked(true)
    // A failed draft must not become the crash-recovery configuration.
    const previous = applied
    await checkProfile(previous)
    await stopCore()
    await startCore(false, previous)
  })
}

export async function attachRunningCore(candidate: PreparedProfile): Promise<void> {
  // A service core may outlive the UI process. Its existing runtime file is the
  // recovery snapshot until this process has successfully applied a new one.
  const yaml = await readFile(candidate.configPath, 'utf8')
  const previous: PreparedProfile = {
    ...candidate,
    yaml,
    config: parseYaml<MihomoConfig>(yaml),
    overrides: []
  }
  await applyRunningProfile(candidate, previous, undefined, true)
}

async function applyRunningProfile(
  candidate: PreparedProfile,
  previous: PreparedProfile,
  beforeRollback?: () => Promise<void>,
  forceReload = false
): Promise<void> {
  let attempted = false
  try {
    // A failed probe must not turn a normal edit into a restart.
    const actual = await mihomoConfig()
    let unchanged = !forceReload && candidate.yaml === previous.yaml
    if (unchanged) {
      try {
        checkAppliedConfig(candidate.config, actual)
      } catch {
        unchanged = false
      }
    }
    if (!unchanged) {
      attempted = true
      await reload(candidate)
    }
    await commitProfile(candidate)
    await acquireMihomoSystemDNSLease()
    await markProfileApplied(candidate)
  } catch (error) {
    await beforeRollback?.()
    if (attempted) {
      try {
        await reload(previous)
        await commitProfile(previous)
        await reconcileMihomoSystemDNSLease()
        await acquireMihomoSystemDNSLease()
      } catch (rollbackError) {
        markProfileStopped()
        throw new Error(
          `配置应用失败：${format(error)}\n恢复上次配置失败：${format(rollbackError)}`
        )
      }
    }
    throw new Error(`配置未应用，保留上次成功配置：${format(error)}`)
  }
}

// Call only while holding the configuration transaction, including source edits.
export async function applyConfigurationUnlocked(
  forceRestart = false,
  prepared?: PreparedProfile,
  beforeRollback?: () => Promise<void>
): Promise<void> {
  const candidate = prepared ?? (await prepareCheckedProfile())
  const previous = applied
  const restart = forceRestart || !running || !previous || requiresCoreRestart(previous, candidate)
  if (!restart) {
    await applyRunningProfile(candidate, previous, beforeRollback)
  } else {
    // Everything above this line is read-only with respect to the running core.
    try {
      await stopCore()
      await startCore(false, candidate)
    } catch (error) {
      await beforeRollback?.()
      if (previous) {
        try {
          const restore = rollbackLaunchPatch(previous, candidate)
          if (Object.keys(restore).length) await patchAppConfig(restore)
          await stopCore()
          await startCore(false, previous)
        } catch (rollbackError) {
          throw new Error(
            `内核启动失败：${format(error)}\n恢复上次配置失败：${format(rollbackError)}`
          )
        }
      }
      throw error
    }
  }
}
