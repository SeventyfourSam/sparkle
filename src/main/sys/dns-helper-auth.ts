import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DnsHelperAuthMaterial } from './dns-helper-protocol'

/**
 * Create/read the user-side credential as an explicit path+token value. The
 * typed material prevents a token from being accidentally passed where the
 * privileged installer requires a path.
 */
export async function ensureDnsHelperAuthFile(filePath: string): Promise<DnsHelperAuthMaterial> {
  if (!path.isAbsolute(filePath) || path.basename(filePath) !== 'dns-helper-auth') {
    throw new Error('DNS helper auth file path must be absolute')
  }

  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  try {
    const existing = (await readFile(filePath, 'utf8')).trim()
    if (/^[0-9a-f]{64}$/i.test(existing)) {
      await chmod(filePath, 0o600)
      return { path: filePath, token: existing }
    }
  } catch {
    // Create a new credential below.
  }

  const token = randomBytes(32).toString('hex')
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporaryPath, `${token}\n`, { mode: 0o600, flag: 'wx' })
  await chmod(temporaryPath, 0o600)
  await rename(temporaryPath, filePath)
  return { path: filePath, token }
}
