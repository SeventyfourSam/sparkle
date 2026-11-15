import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { CodexGateway } from './gateway'
import { defaultCodexWebOptions, validateOptions } from './config'

export function standaloneOptions(args: string[]): ReturnType<typeof defaultCodexWebOptions> {
  const options = defaultCodexWebOptions()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') continue
    if (arg !== '--port' && arg !== '--web-port') throw new Error(`不支持的参数：${arg}`)
    const value = args[++i]
    if (!value || !/^\d+$/.test(value)) throw new Error(`${arg} 需要一个有效端口号`)
    if (arg === '--port') options.port = Number(value)
    else options.webPort = Number(value)
  }
  return validateOptions(options)
}

export async function runStandalone(frontendDir: string, version: string): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log('用法：./start.sh [--port 38471] [--web-port 38472]')
    console.log('Codex 接入监听 127.0.0.1；手机网页监听 0.0.0.0。Ctrl+C 停止。')
    return
  }
  if (args.includes('--version')) {
    console.log(version)
    return
  }
  const options = standaloneOptions(args)
  if (Number(process.versions.node.split('.')[0]) < 24)
    throw new Error('需要 Node.js 24 或更新版本')
  if (!existsSync(resolve(frontendDir, 'codex.html'))) {
    throw new Error('找不到网页构建结果，请重新解压完整部署包；源码运行前请先构建网页')
  }
  const gateway = new CodexGateway({
    ...options,
    frontendDir,
    version,
    log: (message) => console.error(`[Codex Web] ${message}`)
  })
  await gateway.start()
  console.log(`Sparkle Codex Web ${version}`)
  console.log(`Codex 接入：ws://127.0.0.1:${options.port}/codex/app-server`)
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

export function standaloneError(error: unknown): void {
  console.error(`[Codex Web] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
