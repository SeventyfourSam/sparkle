import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packagePattern = /^(\d+\.\d+\.\d+)(?:-custom\.(\d+))?$/

export function nextReleaseVersion(
  upstream: string,
  current: string,
  tags: string[],
  reuse = false
): string {
  const base = upstream.replace(/^v/, '')
  const parsed = packagePattern.exec(current)
  if (!/^\d+\.\d+\.\d+$/.test(base) || !parsed || parsed[1] !== base) {
    throw new Error('Package version does not match the upstream stable release')
  }
  if (reuse && parsed[2]) return current
  let revision = Number(parsed[2] ?? 0)
  for (const tag of tags) {
    const candidate = packagePattern.exec(tag.replace(/^v/, ''))
    if (candidate?.[1] === base) revision = Math.max(revision, Number(candidate[2] ?? 0))
  }
  return `${base}-custom.${revision + 1}`
}

export function releaseArtifacts(version: string): string[] {
  if (!/^\d+\.\d+\.\d+-custom\.[1-9]\d*$/.test(version)) throw new Error('Invalid release version')
  return [
    `sparkle-windows-${version}-x64-setup.exe`,
    `sparkle-windows-${version}-x64-portable.7z`,
    `sparkle-macos-${version}-arm64.pkg`
  ]
}

function main(): void {
  const command = process.argv[2]
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  if (command === 'normalize') {
    const version = packagePattern.exec(pkg.version)?.[1]
    if (!version) throw new Error('Invalid package version')
    pkg.version = version
    writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`)
    return
  }
  if (command === 'version') {
    const tags = execFileSync('git', ['tag', '--list'], { encoding: 'utf8' }).trim().split('\n')
    const version = nextReleaseVersion(
      process.env.UPSTREAM_VERSION ?? '',
      pkg.version,
      tags,
      process.env.REUSE_VERSION === 'true'
    )
    pkg.version = version
    writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`)
    if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required')
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=v${version}\n`)
    return
  }
  if (command === 'manifest') {
    const version = process.env.VERSION ?? pkg.version
    const tag = `v${version}`
    const files = releaseArtifacts(version)
    const hashes = files.map((file) => {
      const data = readFileSync(path.join('dist', file))
      if (!data.length) throw new Error(`Empty release artifact: ${file}`)
      return `${createHash('sha256').update(data).digest('hex')}  ${file}`
    })
    const customNotes = path.join('scripts', 'custom', 'release-notes.md')
    const changelog = [
      `基于 Sparkle ${process.env.UPSTREAM_VERSION ?? version.split('-')[0]}。`,
      `内置 Mihomo ${process.env.MIHOMO_RELEASE_VERSION ?? ''}，内核与应用均从本仓库体系更新。`,
      existsSync(customNotes) ? readFileSync(customNotes, 'utf8').trim() : '',
      readFileSync('changelog.md', 'utf8').trim()
    ]
      .filter(Boolean)
      .join('\n\n')
    // JSON is valid YAML and keeps multiline release notes lossless.
    writeFileSync('latest.yml', `${JSON.stringify({ version, tag, changelog }, null, 2)}\n`)
    writeFileSync('release-notes.md', `${changelog}\n`)
    writeFileSync('SHA256SUMS', `${hashes.join('\n')}\n`)
    return
  }
  throw new Error(`Unknown release command: ${command}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
