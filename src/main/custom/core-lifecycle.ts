import type { ChildProcess } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { getAppConfig, getControledMihomoConfig, patchAppConfig } from '../config'
import { getRuntimeConfig } from '../core/factory'
import { ensureLocalCorePermission, importLocalCore } from '../core/local-core'
import { mihomoConfig } from '../core/mihomoApi'
import {
  acquireMihomoSystemDNSLease,
  hasMihomoDnsListener,
  reconcileMihomoSystemDNSLease,
  releaseMihomoSystemDNSLease,
  shouldManageMihomoSystemDns
} from '../sys/mihomo-system-dns'
import { dataDir } from '../utils/dirs'
import { appendAppLog } from '../utils/log'
import { showNotification } from '../utils/notification'
import { localCoreDir } from './paths'

export function createCustomCoreLifecycle(stopCore: () => Promise<void>) {
  const tunError = (): Error =>
    new Error('虚拟网卡启动失败，请检查内核权限和 TUN 日志；未修改系统 DNS')

  return {
    preserveTunSettings: true,
    async prepareStart(config: AppConfig, corePath: string, useService: boolean): Promise<string> {
      await reconcileMihomoSystemDNSLease()
      if (config.core === 'system') {
        const imported = await importLocalCore(corePath, localCoreDir())
        if (!useService) await ensureLocalCorePermission(imported)
        if (imported !== corePath) await patchAppConfig({ systemCorePath: imported })
        return imported
      }
      if (config.customMihomo?.path === corePath && !useService) {
        await ensureLocalCorePermission(corePath)
      }
      return corePath
    },

    allowPublicDNS(mode: AppConfig['autoSetDNSMode'], config: Partial<MihomoConfig>): boolean {
      return mode !== 'none' && !hasMihomoDnsListener(config)
    },

    isManagedCore(config: AppConfig, corePath: string): boolean {
      return config.customMihomo?.path === corePath
    },

    async onReady(): Promise<void> {
      if ((await getRuntimeConfig()).tun?.enable) {
        try {
          if (!(await mihomoConfig()).tun?.enable) throw tunError()
        } catch (error) {
          await stopCore()
          throw error
        }
      }
      await acquireMihomoSystemDNSLease()
    },

    async completeStartup(
      startup: Promise<Promise<void>[]> | Promise<void>[]
    ): Promise<Promise<void>[]> {
      const promises = await startup
      await Promise.all(promises)
      return promises
    },

    async beforeStop(): Promise<void> {
      try {
        await releaseMihomoSystemDNSLease()
      } catch (error) {
        await appendAppLog(`[Manager]: restore macOS system DNS failed, ${error}\n`)
        void showNotification({
          title: '系统 DNS 恢复失败，内核保持运行',
          body: `${error}`,
          variant: 'danger'
        })
        throw error
      }
    },

    async keepRunning(child?: ChildProcess): Promise<boolean> {
      if (process.platform !== 'darwin' || !child) return false
      const [config, controlled] = await Promise.all([getAppConfig(), getControledMihomoConfig()])
      if (!shouldManageMihomoSystemDns(config.controlDns !== false, controlled)) return false
      if (child.pid) await writeFile(path.join(dataDir(), 'core.pid'), child.pid.toString())
      return true
    }
  }
}
