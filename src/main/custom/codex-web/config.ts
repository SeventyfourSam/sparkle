import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { CODEX_SERVER_PORT, CODEX_WEB_PORT, type CodexWebOptions } from '../../../shared/codex-web'

export function defaultCodexWebOptions(): CodexWebOptions {
  return { port: CODEX_SERVER_PORT, webPort: CODEX_WEB_PORT }
}

export function validateOptions(value: CodexWebOptions): CodexWebOptions {
  if (
    !Number.isInteger(value.port) ||
    value.port < 1024 ||
    value.port > 65535 ||
    !Number.isInteger(value.webPort) ||
    value.webPort < 1024 ||
    value.webPort > 65535
  ) {
    throw new Error('端口必须是 1024–65535 之间的整数')
  }
  return { port: value.port, webPort: value.webPort }
}

export async function readOptions(file: string): Promise<CodexWebOptions> {
  try {
    return validateOptions({
      ...defaultCodexWebOptions(),
      ...JSON.parse(await readFile(file, 'utf8'))
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultCodexWebOptions()
    throw error
  }
}

export async function writeJsonAtomically(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}
