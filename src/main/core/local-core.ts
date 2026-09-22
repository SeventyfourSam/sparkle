import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  stat
} from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const executableName = process.platform === 'win32' ? 'mihomo.exe' : 'mihomo'

/** Use Sparkle's direct-mode setuid mechanism, but only on the imported copy. */
export async function ensureLocalCorePermission(corePath: string): Promise<void> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return
  const isAuthorized = async (): Promise<boolean> => {
    const info = await lstat(corePath)
    if (!info.isFile()) throw new Error('本地内核必须是已导入的普通文件')
    return info.uid === 0 && (info.mode & 0o4111) === 0o4111 && (info.mode & 0o022) === 0
  }
  if (await isAuthorized()) return

  const quotedPath = `'${corePath.replace(/'/g, "'\\''")}'`
  try {
    if (process.platform === 'darwin') {
      const shell = `/usr/sbin/chown root:admin ${quotedPath} && /bin/chmod 4555 ${quotedPath}`
      await execFileAsync('/usr/bin/osascript', [
        '-e',
        `do shell script ${JSON.stringify(shell)} with administrator privileges`
      ])
    } else {
      await execFileAsync('pkexec', [
        'sh',
        '-c',
        `chown root:root ${quotedPath} && chmod 4555 ${quotedPath}`
      ])
    }
    if (!(await isAuthorized())) throw new Error('未获得 root 所有权和 setuid 执行权限')
  } catch (error) {
    throw new Error(`本地内核授权失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Import a standalone executable; never run directly from the user's source directory. */
export async function importLocalCore(sourcePath: string, storageDir: string): Promise<string> {
  if (!path.isAbsolute(sourcePath)) throw new Error('本地内核必须使用绝对路径')
  const source = await realpath(sourcePath)
  const before = await stat(source)
  if (!before.isFile() || before.size === 0) throw new Error('请选择非空的 Mihomo 可执行文件')

  await mkdir(storageDir, { recursive: true, mode: 0o700 })
  const root = await realpath(storageDir)
  const relative = path.relative(root, source).split(path.sep)
  // Reuse our published copy on subsequent core switches and app restarts.
  if (
    relative.length === 2 &&
    /^local-[A-Za-z0-9]+$/.test(relative[0]) &&
    relative[1] === executableName
  ) {
    return source
  }

  const stagingDir = await mkdtemp(path.join(root, '.import-'))
  const stagedCore = path.join(stagingDir, executableName)
  try {
    await copyFile(source, stagedCore, constants.COPYFILE_EXCL)
    const after = await stat(source)
    const copied = await stat(stagedCore)
    if (
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      copied.size !== before.size
    ) {
      throw new Error('复制期间源文件发生变化，请重新导入')
    }

    // Do not inherit writable or setuid bits from a third-party file.
    await chmod(stagedCore, 0o500)
    const { stdout, stderr } = await execFileAsync(stagedCore, ['-v'], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
      windowsHide: true
    })
    if (!/\bmihomo\b/i.test(`${stdout}\n${stderr}`)) {
      throw new Error('所选文件未返回 Mihomo 版本信息')
    }

    const installedDir = path.join(root, path.basename(stagingDir).replace('.import-', 'local-'))
    await rename(stagingDir, installedDir)
    return path.join(installedDir, executableName)
  } catch (error) {
    throw new Error(`导入本地内核失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
  }
}
