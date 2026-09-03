import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const cwd = process.cwd()
const source = path.join(cwd, 'native', 'dns-helper', 'main.swift')
const output = path.join(cwd, 'extra', 'files', 'sparkle-dns-helper')

if (process.platform !== 'darwin') {
  console.log('[INFO]: macOS DNS helper build skipped on non-Darwin target')
  process.exit(0)
}

if (!fs.existsSync(source)) {
  throw new Error(`macOS DNS helper source is missing: ${source}`)
}

const requestedArch =
  process.argv.find((argument) => argument.startsWith('--arch='))?.slice('--arch='.length) ??
  process.env.npm_config_arch ??
  process.arch
const targetArch =
  requestedArch === 'x64' ? 'x86_64' : requestedArch === 'arm64' ? 'arm64' : requestedArch
if (targetArch !== 'arm64' && targetArch !== 'x86_64') {
  throw new Error(`Unsupported macOS DNS helper architecture: ${requestedArch}`)
}

fs.mkdirSync(path.dirname(output), { recursive: true })
const args = [
  '-O',
  '-whole-module-optimization',
  '-target',
  // Sparkle ships a Catalina-compatible x64 package as well as the current
  // arm64 package; the helper uses APIs available on macOS 10.15.
  `${targetArch}-apple-macosx10.15`,
  source,
  '-framework',
  'SystemConfiguration',
  '-framework',
  'CoreFoundation',
  '-framework',
  'Network',
  '-framework',
  'CryptoKit',
  '-o',
  output
]
console.log(`[INFO]: building Sparkle macOS DNS helper for ${targetArch}`)
execFileSync('swiftc', args, { cwd, stdio: 'inherit' })
fs.chmodSync(output, 0o755)
console.log(`[INFO]: macOS DNS helper ready at ${output}`)
