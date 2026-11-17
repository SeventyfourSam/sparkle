import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readDescriptor, runBridge } from './bridge'
import { claudeLaunchConfig, findClaude } from './launch-config'
import { runHook } from './hook'
import { runTerminalWorker } from './terminal-worker'
import { channelAvailable, shouldAttachClaude } from './default-command'

async function main(): Promise<void> {
  const allArgs = process.argv.slice(2)
  const boundary = allArgs.indexOf('--')
  const args = boundary < 0 ? allArgs : allArgs.slice(0, boundary)
  if (args.includes('--terminal-worker')) {
    await runTerminalWorker()
    return
  }
  const descriptorIndex = args.indexOf('--descriptor')
  const descriptor = args[descriptorIndex + 1]
  if (descriptorIndex < 0 || !descriptor) throw new Error('缺少 --descriptor 连接设置文件')
  if (args.includes('--hook')) {
    await runHook(descriptor, args[args.indexOf('--id') + 1])
  } else if (args.includes('--launch') || args.includes('--launch-default')) {
    const remaining =
      boundary >= 0
        ? allArgs.slice(boundary + 1)
        : args
            .filter((_, index) => index !== descriptorIndex && index !== descriptorIndex + 1)
            .filter((arg) => !['--launch', '--launch-default'].includes(arg))
    let config = { args: remaining, env: { ...process.env } }
    delete config.env.ELECTRON_RUN_AS_NODE
    if (args.includes('--launch'))
      config = claudeLaunchConfig(
        await readDescriptor(descriptor),
        descriptor,
        randomUUID(),
        remaining
      )
    else if (shouldAttachClaude(remaining, !!process.stdout.isTTY && !!process.stdin.isTTY)) {
      let connection
      try {
        connection = await readDescriptor(descriptor)
      } catch {
        /* Start the official CLI normally when Sparkle is unavailable. */
      }
      if (connection && (await channelAvailable(connection)))
        config = claudeLaunchConfig(connection, descriptor, randomUUID(), remaining)
    }
    const child = spawn(await findClaude(), config.args, {
      env: config.env,
      stdio: 'inherit',
      shell: false,
      windowsHide: false
    })
    const interrupt = (): void => {
      child.kill('SIGTERM')
    }
    const consoleInterrupt = (): void => {
      // An interactive child receives the console's Ctrl+C itself. Terminating
      // it here would turn "interrupt this turn" into "close Claude".
      if (!process.stdin.isTTY) child.kill('SIGINT')
    }
    process.on('SIGINT', consoleInterrupt)
    process.once('SIGTERM', interrupt)
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code) => {
        process.exitCode = code ?? 1
        resolve()
      })
    })
    process.off('SIGINT', consoleInterrupt)
    process.off('SIGTERM', interrupt)
  } else {
    const id = args[args.indexOf('--id') + 1]
    await runBridge(descriptor, id)
  }
}

main().catch((error) => {
  process.stderr.write(
    `[Sparkle Channel] ${error instanceof Error ? error.message : String(error)}\n`
  )
  process.exitCode = 1
})
