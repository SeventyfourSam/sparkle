import fs from 'fs'
import AdmZip from 'adm-zip'
import path from 'path'
import { systemCoreOnlyBuild } from './build-env.ts'
import { execFileSync } from 'child_process'
import { getMihomoRelease, downloadMihomoRelease } from '../src/shared/mihomo-release.ts'

const cwd = process.cwd()
const TEMP_DIR = path.join(cwd, 'node_modules/.temp')
let arch: string = process.arch
const platform = process.platform
if (process.argv.slice(2).length !== 0) {
  arch = process.argv.slice(2)[0].replace('--', '')
}

if (process.env.SKIP_PREPARE === '1') {
  console.log('Skipping prepare script...')
  process.exit(0)
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function getPlatformAsset(map: Readonly<Partial<Record<string, string>>>): string {
  const name = map[`${platform}-${arch}`]
  if (!name) throw new Error(`unsupported platform "${platform}-${arch}"`)
  return name
}

async function resolveMihomo(): Promise<void> {
  const release = await getMihomoRelease(platform, arch)
  console.log(`Custom Mihomo release: ${release.version}`)
  const executable = await downloadMihomoRelease(release)
  const sidecarDir = path.join(cwd, 'extra', 'sidecar')
  fs.mkdirSync(sidecarDir, { recursive: true })
  const ext = platform === 'win32' ? '.exe' : ''
  for (const name of ['mihomo', 'mihomo-alpha']) {
    // Keep the old alpha filename as an alias for existing permission/service setup.
    const target = path.join(sidecarDir, `${name}${ext}`)
    fs.writeFileSync(target, executable)
    fs.chmodSync(target, 0o755)
  }
  fs.writeFileSync(path.join(sidecarDir, 'mihomo-version.txt'), release.version)
}

interface ResourceInfo {
  file: string
  downloadURL: string
  needExecutable?: boolean
}

/**
 * download the file to the extra dir
 */
async function resolveResource(binInfo: ResourceInfo) {
  const { file, downloadURL, needExecutable = false } = binInfo

  const resDir = path.join(cwd, 'extra', 'files')
  const targetPath = path.join(resDir, file)

  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath)
  }

  fs.mkdirSync(resDir, { recursive: true })
  await downloadFile(downloadURL, targetPath)

  if (needExecutable && platform !== 'win32') {
    fs.chmodSync(targetPath, 0o755)
    console.log(`[INFO]: ${file} chmod finished`)
  }

  console.log(`[INFO]: ${file} finished`)
}

/**
 * download file and save to `path`
 */
async function downloadFile(url: string | URL | Request, path: fs.PathOrFileDescriptor) {
  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/octet-stream' }
  })
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} (${url})`)
  const buffer = await response.arrayBuffer()
  fs.writeFileSync(path, new Uint8Array(buffer))

  console.log(`[INFO]: download finished "${url}"`)
}

const resolveMmdb = () =>
  resolveResource({
    file: 'country.mmdb',
    downloadURL: `https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/country-lite.mmdb`
  })
const resolveMetadb = () =>
  resolveResource({
    file: 'geoip.metadb',
    downloadURL: `https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.metadb`
  })
const resolveGeosite = () =>
  resolveResource({
    file: 'geosite.dat',
    downloadURL: `https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat`
  })
const resolveGeoIP = () =>
  resolveResource({
    file: 'geoip.dat',
    downloadURL: `https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.dat`
  })
const resolveASN = () =>
  resolveResource({
    file: 'ASN.mmdb',
    downloadURL: `https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/GeoLite2-ASN.mmdb`
  })
const resolveBundleMRS = () =>
  resolveResource({
    file: 'BundleMRS.7z',
    downloadURL: `https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/BundleMRS.7z`
  })
const resolveEnableLoopback = () =>
  resolveResource({
    file: 'enableLoopback.exe',
    downloadURL: `https://github.com/Kuingsmile/uwp-tool/releases/download/latest/enableLoopback.exe`
  })
const resolveSparkleService = () => {
  const map = {
    'win32-x64': 'sparkle-service-windows-amd64-v3',
    'win32-ia32': 'sparkle-service-windows-386',
    'win32-arm64': 'sparkle-service-windows-arm64',
    'darwin-x64': 'sparkle-service-darwin-amd64-v3',
    'darwin-arm64': 'sparkle-service-darwin-arm64',
    'linux-x64': 'sparkle-service-linux-amd64-v3',
    'linux-arm64': 'sparkle-service-linux-arm64',
    'linux-loong64': 'sparkle-service-linux-loong64-abi2'
  }
  const base = getPlatformAsset(map)
  const ext = platform == 'win32' ? '.exe' : ''

  return resolveResource({
    file: `sparkle-service${ext}`,
    downloadURL: `https://github.com/UruhaLushia/sparkle-service/releases/download/pre-release/${base}${ext}`,
    needExecutable: true
  })
}
const resolveRunner = () =>
  resolveResource({
    file: 'sparkle-run.exe',
    downloadURL: `https://github.com/xishang0128/sparkle-run/releases/download/${arch}/sparkle-run.exe`
  })

const resolveMonitor = async () => {
  const tempDir = path.join(TEMP_DIR, 'TrafficMonitor')
  const tempZip = path.join(tempDir, `${arch}.zip`)
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true })
  }
  await downloadFile(
    `https://github.com/xishang0128/sparkle-run/releases/download/monitor/${arch}.zip`,
    tempZip
  )
  const zip = new AdmZip(tempZip)
  const resDir = path.join(cwd, 'extra', 'files')
  const targetPath = path.join(resDir, 'TrafficMonitor')
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { recursive: true })
  }
  zip.extractAllTo(targetPath, true)

  console.log(`[INFO]: TrafficMonitor finished`)
}

const resolve7zip = () =>
  resolveResource({
    file: '7za.exe',
    downloadURL: `https://github.com/develar/7zip-bin/raw/master/win/${arch}/7za.exe`
  })
const resolveSubstore = () =>
  resolveResource({
    file: 'sub-store.bundle.js',
    downloadURL:
      'https://github.com/sub-store-org/Sub-Store/releases/latest/download/sub-store.bundle.js'
  })
const resolveSubstoreFrontend = async () => {
  const tempDir = path.join(TEMP_DIR, 'substore-frontend')
  const tempZip = path.join(tempDir, 'dist.zip')
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true })
  }
  await downloadFile(
    'https://github.com/sub-store-org/Sub-Store-Front-End/releases/latest/download/dist.zip',
    tempZip
  )
  const zip = new AdmZip(tempZip)
  const resDir = path.join(cwd, 'extra', 'files')
  const targetPath = path.join(resDir, 'sub-store-frontend')
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { recursive: true })
  }
  zip.extractAllTo(resDir, true)
  fs.renameSync(path.join(resDir, 'dist'), targetPath)

  if (platform !== 'win32') {
    try {
      const fixPermissions = (dir: string): void => {
        const items = fs.readdirSync(dir, { withFileTypes: true })
        for (const item of items) {
          const fullPath = path.join(dir, item.name)
          if (item.isDirectory()) {
            fs.chmodSync(fullPath, 0o755)
            fixPermissions(fullPath)
          } else {
            fs.chmodSync(fullPath, 0o644)
          }
        }
      }
      fs.chmodSync(targetPath, 0o755)
      fixPermissions(targetPath)
      console.log(`[INFO]: sub-store-frontend permissions fixed`)
    } catch (error) {
      console.warn(`[WARN]: Failed to fix permissions: ${getErrorMessage(error)}`)
    }
  }

  console.log(`[INFO]: sub-store-frontend finished`)
}
const resolveFont = async () => {
  // const targetPath = path.join(cwd, 'src', 'renderer', 'src', 'assets', 'NotoColorEmoji.ttf')
  const targetPath = path.join(cwd, 'src', 'renderer', 'src', 'assets', 'twemoji.ttf')

  if (fs.existsSync(targetPath)) {
    return
  }
  await downloadFile(
    // 'https://github.com/googlefonts/noto-emoji/raw/main/fonts/NotoColorEmoji.ttf',
    'https://github.com/Sav22999/emoji/raw/refs/heads/master/font/twemoji.ttf',
    targetPath
  )

  console.log(`[INFO]: twemoji.ttf finished`)
}

type Task = {
  name: string
  func: () => Promise<void>
  retry: number
  winOnly?: boolean
  linuxOnly?: boolean
  unixOnly?: boolean
  darwinOnly?: boolean
}

const tasks: Task[] = [
  {
    name: 'dns-helper',
    func: () =>
      new Promise<void>((resolve, reject) => {
        try {
          execFileSync(process.execPath, ['scripts/build-dns-helper.ts', `--arch=${arch}`], {
            stdio: 'inherit'
          })
          resolve()
        } catch (error) {
          reject(error)
        }
      }),
    retry: 1,
    darwinOnly: true
  },
  {
    name: 'mihomo',
    func: resolveMihomo,
    retry: 5
  },
  { name: 'mmdb', func: resolveMmdb, retry: 5 },
  { name: 'metadb', func: resolveMetadb, retry: 5 },
  { name: 'geosite', func: resolveGeosite, retry: 5 },
  { name: 'geoip', func: resolveGeoIP, retry: 5 },
  { name: 'asn', func: resolveASN, retry: 5 },
  { name: 'bundlemrs', func: resolveBundleMRS, retry: 5 },
  {
    name: 'font',
    func: resolveFont,
    retry: 5
  },
  {
    name: 'enableLoopback',
    func: resolveEnableLoopback,
    retry: 5,
    winOnly: true
  },
  {
    name: 'sparkle-service',
    func: resolveSparkleService,
    retry: 5
  },
  {
    name: 'runner',
    func: resolveRunner,
    retry: 5,
    winOnly: true
  },
  {
    name: 'monitor',
    func: resolveMonitor,
    retry: 5,
    winOnly: true
  },
  {
    name: 'substore',
    func: resolveSubstore,
    retry: 5
  },
  {
    name: 'substorefrontend',
    func: resolveSubstoreFrontend,
    retry: 5
  },
  {
    name: '7zip',
    func: resolve7zip,
    retry: 5,
    winOnly: true
  }
]

if (systemCoreOnlyBuild) {
  tasks.splice(
    tasks.findIndex((task) => task.name === 'mihomo'),
    1
  )
  console.log('[INFO]: System-core-only build: skipping mihomo downloads')
}

async function runTask(): Promise<void> {
  const task = tasks.shift()
  if (!task) return
  if (task.winOnly && platform !== 'win32') return runTask()
  if (task.linuxOnly && platform !== 'linux') return runTask()
  if (task.unixOnly && platform === 'win32') return runTask()
  if (task.darwinOnly && platform !== 'darwin') return runTask()

  for (let i = 0; i < task.retry; i++) {
    try {
      await task.func()
      break
    } catch (err) {
      console.error(`[ERROR]: task::${task.name} try ${i} ==`, getErrorMessage(err))
      if (i === task.retry - 1) throw err
    }
  }
  return runTask()
}

runTask()
runTask()
