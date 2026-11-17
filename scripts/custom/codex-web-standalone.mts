import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { CodexGateway } from '../../src/main/custom/codex-web/gateway'
import { defaultCodexWebOptions, validateOptions } from '../../src/main/custom/codex-web/config'

async function main(): Promise<void> {
  const options = defaultCodexWebOptions()
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') continue
    if (arg === '--help' || arg === '-h') {
      console.log('用法：pnpm run serve:codex-web [--port 38471] [--web-port 38472]')
      return
    }
    if (arg !== '--port' && arg !== '--web-port') throw new Error(`不支持的参数：${arg}`)
    const value = args[++i]
    if (!value || !/^\d+$/.test(value)) throw new Error(`${arg} 需要一个有效端口号`)
    if (arg === '--port') options.port = Number(value)
    else options.webPort = Number(value)
  }
  validateOptions(options)

  const frontendDir = resolve(import.meta.dirname, '../../out/renderer')
  if (!existsSync(resolve(frontendDir, 'codex.html'))) {
    throw new Error('找不到网页构建结果，请先在项目目录运行 pnpm exec electron-vite build')
  }
  const gateway = new CodexGateway({
    ...options,
    frontendDir,
    version: process.env.npm_package_version || 'standalone',
    claude: {
      directory: resolve(homedir(), '.local/share/sparkle-claude-channel'),
      bridgeFile: resolve(import.meta.dirname, '../../out/main/claude-channel.js'),
      defaultCommand: true
    },
    log: (message) => console.error(`[Codex Web] ${message}`)
  })
  await gateway.start()
  console.log(`Codex 接入：127.0.0.1:${options.port}/codex/app-server`)
  console.log(`网页访问：http://127.0.0.1:${options.webPort}/ （监听 0.0.0.0）`)
  const shutdown = (): void => {
    void gateway.stop().then(
      () => process.exit(0),
      (error) => {
        console.error(error)
        process.exit(1)
      }
    )
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

main().catch((error) => {
  console.error(`[Codex Web] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
