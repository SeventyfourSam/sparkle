import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  isRunningAsAdmin as nativeIsRunningAsAdmin,
  runElevated
} from '@uruhalushia/sparkle-native'

const execFilePromise = promisify(execFile)

let isAdminCached: boolean | null = null

async function isRunningAsAdmin(): Promise<boolean> {
  if (isAdminCached !== null) {
    return isAdminCached
  }

  try {
    isAdminCached = nativeIsRunningAsAdmin()
  } catch {
    isAdminCached = false
  }
  return isAdminCached
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

function appleScriptQuote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export async function execWithElevation(command: string, args: string[]): Promise<void> {
  if (process.platform === 'win32') {
    try {
      if (await isRunningAsAdmin()) {
        await execFilePromise(command, args, { timeout: 30000 })
      } else {
        const exitCode = runElevated(command, args)
        if (exitCode !== 0) {
          throw new Error(`exit code ${exitCode}`)
        }
      }
    } catch (error) {
      throw new Error(
        `Windows 提权执行失败：${error instanceof Error ? error.message : String(error)}`
      )
    }
  } else if (process.platform === 'linux') {
    try {
      await execFilePromise('pkexec', [command, ...args])
    } catch (error) {
      throw new Error(
        `Linux 提权执行失败：${error instanceof Error ? error.message : String(error)}`
      )
    }
  } else if (process.platform === 'darwin') {
    const cmd = [command, ...args].map(shellQuote).join(' ')
    try {
      await execFilePromise('osascript', [
        '-e',
        `do shell script "${appleScriptQuote(cmd)}" with administrator privileges`
      ])
    } catch (error) {
      throw new Error(
        `macOS 提权执行失败：${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}

/**
 * Run a fixed, packaged helper with administrator privileges and return its
 * stdout.  The macOS DNS helper uses JSON on stdout so callers can inspect a
 * failed transaction without turning the helper into a general root shell.
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
