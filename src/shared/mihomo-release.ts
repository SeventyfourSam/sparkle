import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import AdmZip from 'adm-zip'

export const MIHOMO_REPOSITORY = 'SeventyfourSam/mihomo'

export const MIHOMO_RELEASE_API = `https://api.github.com/repos/${MIHOMO_REPOSITORY}/releases/latest`
const VERSION_PATTERN = /^v(\d+)\.(\d+)\.(\d+)-custom\.(\d+)$/
const ASSETS: Readonly<Partial<Record<string, string>>> = {
  'win32-x64': 'mihomo-windows-amd64',
  'darwin-arm64': 'mihomo-darwin-arm64'
}

export interface MihomoRelease {
  version: string
  assetName: string
  executableName: string
  downloadURL: string
  checksumURL: string
}

export type ReleaseRequest = (url: string) => Promise<Buffer>

export async function requestReleaseFile(url: string): Promise<Buffer> {
  const isGitHubApi = new URL(url).origin === 'https://api.github.com'
  const token = isGitHubApi && (process.env.GH_TOKEN || process.env.GITHUB_TOKEN)
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Sparkle',
      Accept: isGitHubApi ? 'application/vnd.github+json' : 'application/octet-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    signal: AbortSignal.timeout(120_000)
  })
  if (!response.ok) {
    const detail = isGitHubApi
      ? await response
          .json()
          .then((data: { message?: string }) => data.message || '')
          .catch(() => '')
      : ''
    throw new Error(
      `Download failed: HTTP ${response.status} (${url})${detail ? `: ${detail}` : ''}`
    )
  }
  return Buffer.from(await response.arrayBuffer())
}

export function selectMihomoRelease(data: unknown, platform: string, arch: string): MihomoRelease {
  const base = ASSETS[`${platform}-${arch}`]
  if (!base) throw new Error(`自定义 Mihomo 尚未提供 ${platform}-${arch} 构建`)
  const release = data as {
    tag_name?: string
    draft?: boolean
    prerelease?: boolean
    assets?: { name: string }[]
  } | null
  const version = release?.tag_name
  if (!version || !VERSION_PATTERN.test(version) || release?.draft || release?.prerelease) {
    throw new Error('无效的自定义 Mihomo 正式 Release')
  }
  const isWin = platform === 'win32'
  const assetName = `${base}-${version}.${isWin ? 'zip' : 'gz'}`
  if (
    !Array.isArray(release.assets) ||
    !release.assets.some((asset) => asset.name === assetName) ||
    !release.assets.some((asset) => asset.name === 'SHA256SUMS')
  ) {
    throw new Error(`自定义 Mihomo Release 缺少 ${assetName} 或 SHA256SUMS`)
  }
  const prefix = `https://github.com/${MIHOMO_REPOSITORY}/releases/download/${version}`
  return {
    version,
    assetName,
    executableName: `${base}${isWin ? '.exe' : ''}`,
    downloadURL: `${prefix}/${assetName}`,
    checksumURL: `${prefix}/SHA256SUMS`
  }
}

export async function getMihomoRelease(
  platform = process.platform,
  arch: string = process.arch,
  request: ReleaseRequest = requestReleaseFile,
  version?: string
): Promise<MihomoRelease> {
  if (version && !VERSION_PATTERN.test(version)) throw new Error('Invalid Mihomo release version')
  const url = version
    ? `https://api.github.com/repos/${MIHOMO_REPOSITORY}/releases/tags/${version}`
    : MIHOMO_RELEASE_API
  const release = selectMihomoRelease(JSON.parse((await request(url)).toString()), platform, arch)
  if (version && release.version !== version) throw new Error('Mihomo release version mismatch')
  return release
}

export function verifyMihomoChecksum(data: Buffer, sums: string, assetName: string): void {
  const expected = sums
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+\*?/))
    .find(([, name]) => name === assetName)?.[0]
  if (!expected || !/^[a-f\d]{64}$/i.test(expected)) {
    throw new Error(`SHA256SUMS 中缺少 ${assetName} 的有效校验值`)
  }
  if (createHash('sha256').update(data).digest('hex') !== expected.toLowerCase()) {
    throw new Error(`自定义 Mihomo SHA-256 校验失败：${assetName}`)
  }
}

export async function downloadMihomoRelease(
  release: MihomoRelease,
  request: ReleaseRequest = requestReleaseFile
): Promise<Buffer> {
  const [archive, sums] = await Promise.all([
    request(release.downloadURL),
    request(release.checksumURL)
  ])
  verifyMihomoChecksum(archive, sums.toString(), release.assetName)
  if (release.assetName.endsWith('.zip')) {
    const entry = new AdmZip(archive).getEntry(release.executableName)
    if (!entry || entry.isDirectory) throw new Error('自定义 Mihomo 压缩包缺少可执行文件')
    return entry.getData()
  }
  return gunzipSync(archive)
}
