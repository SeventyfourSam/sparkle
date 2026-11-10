import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { getMihomoRelease, downloadMihomoRelease } from '../../src/shared/mihomo-release.ts'

interface PrepareTask {
  name: string
  func: () => Promise<void>
  retry: number
}

export async function prepareCustomMihomo(arch: string): Promise<void> {
  const release = await getMihomoRelease(
    process.platform,
    arch,
    undefined,
    process.env.MIHOMO_RELEASE_VERSION
  )
  console.log(`Custom Mihomo release: ${release.version}`)
  const executable = await downloadMihomoRelease(release)
  const sidecarDir = path.join(process.cwd(), 'extra', 'sidecar')
  fs.mkdirSync(sidecarDir, { recursive: true })
  const ext = process.platform === 'win32' ? '.exe' : ''
  for (const name of ['mihomo', 'mihomo-alpha']) {
    const target = path.join(sidecarDir, `${name}${ext}`)
    fs.writeFileSync(target, executable)
    fs.chmodSync(target, 0o755)
  }
  fs.writeFileSync(path.join(sidecarDir, 'mihomo-version.txt'), release.version)
}

/** Replace named core tasks after upstream has applied its system-core-only filter. */
export function customizePrepareTasks(tasks: PrepareTask[], arch: string): void {
  const bundledCore = tasks.some((task) => task.name === 'mihomo')
  for (let i = tasks.length - 1; i >= 0; i--) {
    if (['mihomo', 'mihomo-alpha'].includes(tasks[i].name)) tasks.splice(i, 1)
  }
  if (bundledCore) {
    tasks.unshift({ name: 'mihomo', func: () => prepareCustomMihomo(arch), retry: 5 })
  }
  if (process.platform === 'darwin') {
    tasks.unshift({
      name: 'dns-helper',
      retry: 1,
      func: async () => {
        execFileSync(process.execPath, ['scripts/build-dns-helper.ts', `--arch=${arch}`], {
          stdio: 'inherit'
        })
      }
    })
  }
}
