import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { mihomoCorePath } from '../utils/dirs'
import type { PreparedProfile } from '../custom/profile-builder'
import { createCoreEnvironment } from '../core/startup-chain'

export async function checkProfile(profile: PreparedProfile, corePath?: string): Promise<void> {
  const {
    core = 'mihomo',
    safePaths = [],
    disableLoopbackDetector = false,
    disableEmbedCA = false,
    disableSystemCA = false,
    disableNftables = false
  } = profile.appConfig
  corePath ??= mihomoCorePath(core)
  const execFilePromise = promisify(execFile)
  const env = createCoreEnvironment({
    safePaths,
    disableLoopbackDetector,
    disableEmbedCA,
    disableSystemCA,
    disableNftables
  })
  // Use the real work directory so relative provider/geo paths mean exactly the
  // same thing in validation and in the running core. Never replace config.yaml.
  await mkdir(profile.workDir, { recursive: true })
  const candidate = path.join(profile.workDir, `.sparkle-check-${randomUUID()}.yaml`)
  try {
    await writeFile(candidate, profile.yaml, { encoding: 'utf8', mode: 0o600 })
    await execFilePromise(corePath, ['-t', '-f', candidate, '-d', profile.workDir], {
      env,
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024
    })
  } catch (error) {
    const execError = error as {
      stdout?: string
      stderr?: string
      message?: string
    }
    const output = [execError.stdout, execError.stderr]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n')
    const errorLines = output
      .split('\n')
      .filter((line) => line.includes('level=error'))
      .map((line) => line.split('level=error', 2)[1]?.trim() || line.trim())
    const message = errorLines.join('\n') || output.trim() || execError.message || String(error)
    throw new Error(`配置预检失败，未应用修改：\n${message}`)
  } finally {
    await rm(candidate, { force: true })
  }
}
