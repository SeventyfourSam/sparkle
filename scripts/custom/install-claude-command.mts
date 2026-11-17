import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { readDescriptor } from '../../src/main/custom/claude-channel/bridge'
import {
  appendDefaultCommandProfile,
  defaultCommandDirectory,
  enableDefaultCommand
} from '../../src/main/custom/claude-channel/default-command'
import { findClaude } from '../../src/main/custom/claude-channel/launch-config'

const file = resolve(process.argv[2] || 'dist/codex-web-preview/claude/connection.json')
const descriptor = await readDescriptor(file)
const executable = await findClaude()
await enableDefaultCommand(file, descriptor, executable)
const run = promisify(execFile)
if (process.platform === 'win32') {
  const profiles = new Set<string>()
  for (const shell of [
    join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    'pwsh.exe'
  ]) {
    try {
      const { stdout } = await run(
        shell,
        ['-NoProfile', '-Command', '$PROFILE.CurrentUserAllHosts'],
        { windowsHide: true, timeout: 10000 }
      )
      profiles.add(stdout.trim())
    } catch {
      /* This PowerShell edition is not installed. */
    }
  }
  if (!profiles.size) throw new Error('没有找到 PowerShell 配置位置')
  for (const profile of profiles) {
    await appendDefaultCommandProfile(profile)
    console.log(`已设置：${profile}`)
  }
  const updatePath = `$sparkleKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
try {
  $sparkleOldPath = [string]$sparkleKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $sparkleKind = if ($sparkleKey.GetValueNames() -contains 'Path') { $sparkleKey.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
  $sparkleBin = $env:SPARKLE_CLAUDE_COMMAND_BIN
  $sparkleSegments = @($sparkleOldPath -split ';' | Where-Object { $_ -and $_.TrimEnd('\\') -ine $sparkleBin.TrimEnd('\\') })
  $sparkleKey.SetValue('Path', (@($sparkleBin) + $sparkleSegments) -join ';', $sparkleKind)
} finally { $sparkleKey.Close() }
try {
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class SparkleEnvironmentNotify { [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, string l, uint f, uint t, out IntPtr r); }'
  $sparkleResult = [IntPtr]::Zero
  [void][SparkleEnvironmentNotify]::SendMessageTimeout([IntPtr]65535, 26, [IntPtr]::Zero, 'Environment', 2, 1000, [ref]$sparkleResult)
} catch { }`
  await run('powershell.exe', ['-NoProfile', '-Command', updatePath], {
    windowsHide: true,
    timeout: 10000,
    env: { ...process.env, SPARKLE_CLAUDE_COMMAND_BIN: join(defaultCommandDirectory(), 'bin') }
  })
  console.log('新开的 PowerShell 和重新启动的终端可直接使用 claude。')
} else {
  console.log(`将 ${join(defaultCommandDirectory(), 'bin')} 放到 PATH 前面即可直接使用 claude。`)
}
