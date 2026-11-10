import axios from 'axios'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getAppConfig, getControledMihomoConfig, patchAppConfig } from '../config'
import { localCoreDir } from '../utils/dirs'
import { appendAppLog } from '../utils/log'
import { downloadMihomoRelease, getMihomoRelease } from '../../shared/mihomo-release'
import { ensureLocalCorePermission, importLocalCore } from './local-core'
import { mihomoVersion } from './mihomoApi'
import { startCore, stopCore } from './manager'

let updating = false

export async function upgradeCustomMihomo(): Promise<void> {
  if (updating) throw new Error('自定义 Mihomo 正在更新')
  updating = true
  let tempDir: string | undefined
  try {
    const config = await getAppConfig()
    if (config.core === 'system') {
      throw new Error('本地内核不支持在线升级，请重新导入编译后的文件')
    }
    const { 'mixed-port': mixedPort = 7890 } = await getControledMihomoConfig()
    const request = async (url: string): Promise<Buffer> => {
      const response = await axios.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
        timeout: 120_000,
        maxContentLength: 64 * 1024 * 1024,
        headers: {
          'User-Agent': 'Sparkle',
          ...(url.startsWith('https://api.github.com/') && config.githubToken?.trim()
            ? { Authorization: `Bearer ${config.githubToken.trim()}` }
            : {})
        },
        ...(mixedPort !== 0 && {
          proxy: { protocol: 'http', host: '127.0.0.1', port: mixedPort }
        })
      })
      return Buffer.from(response.data)
    }
    const release = await getMihomoRelease(process.platform, process.arch, request)
    if ((await mihomoVersion()).version === release.version) {
      throw new Error(`already using latest version ${release.version}`)
    }
    const executable = await downloadMihomoRelease(release, request)
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'sparkle-mihomo-'))
    const candidate = path.join(tempDir, release.executableName)
    await writeFile(candidate, executable, { mode: 0o700 })
    const installedPath = await importLocalCore(candidate, localCoreDir())
    if (config.corePermissionMode !== 'service') {
      await ensureLocalCorePermission(installedPath)
    }
    const current = await getAppConfig()
    if (
      current.core !== config.core ||
      current.corePermissionMode !== config.corePermissionMode ||
      current.customMihomo?.path !== config.customMihomo?.path
    ) {
      throw new Error('下载期间内核设置已变更，请重新更新')
    }
    await stopCore()
    try {
      await patchAppConfig({ customMihomo: { path: installedPath, version: release.version } })
      await Promise.all(await startCore())
      if ((await mihomoVersion()).version !== release.version) {
        throw new Error('更新后的 Mihomo 版本不匹配')
      }
    } catch (error) {
      await stopCore()
      await patchAppConfig({ customMihomo: config.customMihomo ?? { path: '', version: '' } })
      try {
        await Promise.all(await startCore())
      } catch (rollbackError) {
        await appendAppLog(`[Updater]: Mihomo rollback startup failed: ${rollbackError}\n`)
      }
      throw error
    }
  } finally {
    updating = false
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
  }
}
