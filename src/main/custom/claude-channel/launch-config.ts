import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { ClaudeChannelDescriptor } from '../../../shared/claude-channel'

export async function findClaude(): Promise<string> {
  const binary = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const pathValue =
    Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || ''
  const directories = [
    join(homedir(), '.local', 'bin'),
    ...pathValue.split(process.platform === 'win32' ? ';' : ':'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ]
  for (const directory of [...new Set(directories)].filter(isAbsolute)) {
    const file = join(directory, binary)
    try {
      if ((await stat(file)).isFile()) {
        await access(file, constants.X_OK)
        return file
      }
    } catch {
      /* Try the next official CLI installation. */
    }
  }
  throw new Error('未找到官方 Claude Code，请先安装并在官方 CLI 中完成登录')
}

export function claudeLaunchConfig(
  descriptor: ClaudeChannelDescriptor,
  descriptorFile: string,
  id: string,
  extra: string[] = []
): { args: string[]; env: NodeJS.ProcessEnv } {
  if (
    extra.some((arg) =>
      [
        '-p',
        '--print',
        '--sdk-url',
        '--dangerously-skip-permissions',
        '--mcp-config',
        '--settings',
        '--setting-sources'
      ].includes(arg)
    )
  )
    throw new Error('Channel 启动入口需要交互模式；不支持覆盖连接参数或跳过权限确认')
  const mcp = {
    mcpServers: {
      sparkle: {
        type: 'stdio',
        command: descriptor.runtime,
        args: [descriptor.bridge, '--descriptor', descriptorFile, '--id', id],
        env: { ELECTRON_RUN_AS_NODE: '1' }
      }
    }
  }
  // Hook arrays merge with the user's existing hooks. These callbacks observe only;
  // an unavailable Sparkle must never authorize, deny or block a native tool call.
  const hook = {
    type: 'http',
    url: descriptor.hookUrl,
    timeout: 2,
    onFailure: 'continue',
    headers: { Authorization: `Bearer ${descriptor.token}`, 'X-Sparkle-Session': id }
  }
  const events = [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
    'Stop',
    'StopFailure',
    'SessionEnd',
    'MessageDisplay',
    'PostModelSwitch'
  ]
  // Session lifecycle events do not accept HTTP hooks. Keep Electron's Node
  // mode local to this observer child, rather than changing Claude's environment.
  const windows = process.platform === 'win32'
  const quote = (text: string): string =>
    windows ? `'${text.replace(/'/g, "''")}'` : `'${text.replace(/'/g, `'\\''`)}'`
  const invocation = [
    descriptor.runtime,
    descriptor.bridge,
    '--hook',
    '--descriptor',
    descriptorFile,
    '--id',
    id
  ]
    .map(quote)
    .join(' ')
  const lifecycle = {
    type: 'command',
    command: windows
      ? `$env:ELECTRON_RUN_AS_NODE='1'; & ${invocation}`
      : `ELECTRON_RUN_AS_NODE=1 ${invocation}`,
    ...(windows ? { shell: 'powershell' } : {}),
    timeout: 5,
    onFailure: 'continue'
  }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return {
    args: [
      '--mcp-config',
      JSON.stringify(mcp),
      '--settings',
      JSON.stringify({
        hooks: Object.fromEntries(
          events.map((event) => [
            event,
            [
              {
                hooks: [
                  ['SessionStart', 'SessionEnd', 'PostModelSwitch'].includes(event)
                    ? lifecycle
                    : hook
                ]
              }
            ]
          ])
        )
      }),
      '--dangerously-load-development-channels',
      'server:sparkle',
      ...extra
    ],
    env
  }
}
