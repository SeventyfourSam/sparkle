import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { resourcesFilesDir } from '../utils/dirs'
import { isRunningAsAdmin as nativeIsRunningAsAdmin } from '@uruhalushia/sparkle-native'

const execFilePromise = promisify(execFile)

let isAdminCached: boolean | null = null

async function isRunningAsAdmin(): Promise<boolean> {
  if (isAdminCached !== null) return isAdminCached
  try {
    isAdminCached = nativeIsRunningAsAdmin()
  } catch {
    isAdminCached = false
  }
  return isAdminCached
}

/** Resolve the packaged helper locally so generic directory utilities stay upstream-compatible. */
export function dnsHelperPath(): string {
  return path.join(resourcesFilesDir(), 'sparkle-dns-helper')
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

function appleScriptQuote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Run the fixed packaged DNS helper with administrator privileges and return
 * its JSON-bearing stdout. The helper itself constrains every privileged
 * operation to the authenticated install/status protocol.
 */
export async function execWithElevationOutput(command: string, args: string[]): Promise<string> {
  if (process.platform === 'darwin') {
    const cmd = [command, ...args].map(shellQuote).join(' ')
    try {
      const { stdout } = await execFilePromise('osascript', [
        '-e',
        `do shell script "${appleScriptQuote(cmd)}" with administrator privileges`
      ])
      return stdout
    } catch (error) {
      const stdout =
        error && typeof error === 'object' && 'stdout' in error
          ? String((error as { stdout?: unknown }).stdout ?? '')
          : ''
      const detail = stdout.trim() || (error instanceof Error ? error.message : String(error))
      throw new Error(`macOS 提权执行失败：${detail}`)
    }
  }

  if (process.platform === 'linux') {
    try {
      const { stdout } = await execFilePromise('pkexec', [command, ...args])
      return stdout
    } catch (error) {
      throw new Error(
        `Linux 提权执行失败：${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  if (process.platform === 'win32') {
    if (!(await isRunningAsAdmin())) {
      throw new Error('Windows 不支持带输出的提权 helper')
    }
    try {
      const { stdout } = await execFilePromise(command, args, { timeout: 30000 })
      return stdout
    } catch (error) {
      throw new Error(
        `Windows 提权执行失败：${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  throw new Error(`不支持的平台：${process.platform}`)
}
