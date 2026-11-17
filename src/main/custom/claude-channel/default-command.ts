import { readFile, writeFile, mkdir, chmod, access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'
import type { ClaudeChannelDescriptor } from '../../../shared/claude-channel'
import { writeJsonAtomically } from '../codex-web/config'

export const defaultCommandDirectory = (): string =>
  join(homedir(), '.local', 'share', 'sparkle', 'claude-command')
const profileBegin = '# >>> Sparkle claude defaults >>>'
const profileEnd = '# <<< Sparkle claude defaults <<<'

export function shouldAttachClaude(args: string[], interactive: boolean): boolean {
  if (!interactive) return false
  const commands = [
    'agents',
    'attach',
    'auth',
    'auto-mode',
    'doctor',
    'install',
    'logs',
    'mcp',
    'plugin',
    'plugins',
    'remote-control',
    'rm',
    'setup-token',
    'skills',
    'stop',
    'update',
    'upgrade',
    'desktop',
    'config'
  ]
  if (commands.includes(args[0])) return false
  const standalone = [
    '-p',
    '--print',
    '-v',
    '--version',
    '-h',
    '--help',
    '--bare',
    '--safe-mode',
    '--bg',
    '--background',
    '--cloud',
    '--desktop',
    '--remote-control',
    '--sdk-url',
    '--mcp-config',
    '--settings',
    '--setting-sources',
    '--channels',
    '--dangerously-load-development-channels',
    '--dangerously-skip-permissions'
  ]
  return !args.some((arg) => standalone.includes(arg.split('=')[0]))
}

export async function channelAvailable(descriptor: ClaudeChannelDescriptor): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new WebSocket(descriptor.url, {
      handshakeTimeout: 500,
      headers: { Authorization: `Bearer ${descriptor.token}`, 'X-Sparkle-Session': randomUUID() }
    })
    let done = false
    const finish = (ready: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(ready)
      if (ready) socket.close()
      else socket.terminate()
    }
    const timer = setTimeout(() => finish(false), 600)
    socket.once('open', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('close', () => finish(false))
  })
}

export async function publishDefaultCommand(
  file: string,
  descriptor: ClaudeChannelDescriptor,
  directory = defaultCommandDirectory()
): Promise<boolean> {
  let settings: { version: number; executable: string }
  try {
    settings = JSON.parse(await readFile(join(directory, 'enabled.json'), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  if (settings.version !== 1 || !isAbsolute(settings.executable))
    throw new Error('Claude 默认命令设置无效')
  // Shells cannot stat Electron's virtual archive paths; the runtime can read them.
  const bridgeContainer = descriptor.bridge.replace(/([\\/]app\.asar)[\\/].*$/, '$1')
  await writeJsonAtomically(join(directory, 'active.json'), {
    runtime: descriptor.runtime,
    bridge: descriptor.bridge,
    bridgeContainer,
    descriptorFile: file,
    executable: settings.executable
  })
  const bin = join(directory, 'bin')
  await mkdir(bin, { recursive: true, mode: 0o700 })
  const cmd = (path: string): string => path.replace(/%/g, '%%')
  const sh = (path: string): string => `'${path.replace(/'/g, `'\\''`)}'`
  const script =
    process.platform === 'win32'
      ? `@echo off\r\nsetlocal DisableDelayedExpansion\r\nif not exist "${cmd(descriptor.runtime)}" goto native\r\nif not exist "${cmd(bridgeContainer)}" goto native\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${cmd(descriptor.runtime)}" "${cmd(descriptor.bridge)}" --launch-default --descriptor "${cmd(file)}" -- %*\r\nexit /b %errorlevel%\r\n:native\r\n"${cmd(settings.executable)}" %*\r\nexit /b %errorlevel%\r\n`
      : `#!/bin/sh\nif [ -f ${sh(descriptor.runtime)} ] && [ -f ${sh(bridgeContainer)} ]; then\n  ELECTRON_RUN_AS_NODE=1 exec ${sh(descriptor.runtime)} ${sh(descriptor.bridge)} --launch-default --descriptor ${sh(file)} -- "$@"\nfi\nexec ${sh(settings.executable)} "$@"\n`
  const launcher = join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude')
  await writeFile(launcher, script, { mode: 0o700 })
  await chmod(launcher, 0o700)
  if (process.platform === 'win32') {
    const quote = (text: string): string => `'${text.replace(/'/g, "''")}'`
    const bootstrap = `function global:claude {\n  $sparkleArguments = $args\n  $sparkleLaunch = $null\n  try { $sparkleLaunch = Get-Content -LiteralPath ${quote(join(directory, 'active.json'))} -Raw -ErrorAction Stop | ConvertFrom-Json } catch {}\n  if ($sparkleLaunch -and (Test-Path -LiteralPath $sparkleLaunch.runtime) -and (Test-Path -LiteralPath $sparkleLaunch.bridgeContainer)) {\n    $sparkleNodeMode = [Environment]::GetEnvironmentVariable('ELECTRON_RUN_AS_NODE', 'Process')\n    try {\n      $env:ELECTRON_RUN_AS_NODE = '1'\n      & $sparkleLaunch.runtime $sparkleLaunch.bridge --launch-default --descriptor $sparkleLaunch.descriptorFile -- @sparkleArguments\n    } finally { [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', $sparkleNodeMode, 'Process') }\n    return\n  }\n  & ${quote(settings.executable)} @sparkleArguments\n}\n`
    await writeFile(join(directory, 'command.ps1'), '\uFEFF' + bootstrap, { mode: 0o600 })
  }
  return true
}

export async function appendDefaultCommandProfile(file: string): Promise<boolean> {
  let previous: Buffer
  try {
    previous = await readFile(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    previous = Buffer.alloc(0)
  }
  const encoding = previous[0] === 0xff && previous[1] === 0xfe ? 'utf16le' : 'utf8'
  const text = previous.toString(encoding)
  if (text.includes(profileBegin)) return false
  const block = `${text && !text.endsWith('\n') ? '\r\n' : ''}${profileBegin}\r\n$sparkleClaudeHome = Join-Path $HOME '.local\\share\\sparkle\\claude-command'\r\n$sparkleClaudeBootstrap = Join-Path $sparkleClaudeHome 'command.ps1'\r\nif (Test-Path -LiteralPath $sparkleClaudeBootstrap) {\r\n  $sparkleClaudeBin = Join-Path $sparkleClaudeHome 'bin'\r\n  if (($env:Path -split ';') -notcontains $sparkleClaudeBin) { $env:Path = $sparkleClaudeBin + ';' + $env:Path }\r\n  . $sparkleClaudeBootstrap\r\n}\r\n${profileEnd}\r\n`
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, Buffer.concat([previous, Buffer.from(block, encoding)]))
  return true
}

export async function enableDefaultCommand(
  file: string,
  descriptor: ClaudeChannelDescriptor,
  executable: string,
  directory = defaultCommandDirectory()
): Promise<void> {
  if (!isAbsolute(executable)) throw new Error('Claude 原生命令路径无效')
  await access(executable)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeJsonAtomically(join(directory, 'enabled.json'), { version: 1, executable })
  await publishDefaultCommand(file, descriptor, directory)
}
