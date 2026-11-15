import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { build, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { create as createTar } from 'tar'

const root = resolve(import.meta.dirname, '../..')
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
if (!/^\d+\.\d+\.\d+-custom\.[1-9]\d*$/.test(version)) throw new Error('Invalid package version')
const args = process.argv.slice(2)
if (args.some((arg) => arg !== '--macos-arm64')) throw new Error('Only --macos-arm64 is supported')
const includeMac = args.includes('--macos-arm64')
if (includeMac && (process.platform !== 'darwin' || process.arch !== 'arm64')) {
  throw new Error('Build the macOS ARM64 package on a native macOS ARM64 runner')
}
const temporary = await mkdtemp(join(tmpdir(), 'sparkle-codex-web-build-'))
const packages = new Set<string>()
const licenses = (): Plugin => ({
  name: 'collect-bundled-licenses',
  generateBundle() {
    for (const id of this.getModuleIds()) {
      if (!id.includes('node_modules') || id.startsWith('\0')) continue
      let directory = dirname(id.split('?')[0])
      while (directory !== dirname(directory)) {
        if (existsSync(join(directory, 'package.json'))) {
          packages.add(directory)
          break
        }
        directory = dirname(directory)
      }
    }
  }
})

try {
  const name = `sparkle-codex-web-${version}-node`
  const stage = join(temporary, name)
  await mkdir(stage)
  await build({
    configFile: false,
    root: join(root, 'src/renderer'),
    base: '/',
    publicDir: false,
    plugins: [react(), tailwindcss(), licenses()],
    worker: { plugins: () => [licenses()] },
    build: {
      outDir: join(stage, 'public'),
      emptyOutDir: false,
      rollupOptions: { input: join(root, 'src/renderer/codex.html') }
    }
  })
  await build({
    configFile: false,
    root,
    publicDir: false,
    plugins: [licenses()],
    define: {
      __CODEX_WEB_VERSION__: JSON.stringify(version),
      'process.env.WS_NO_BUFFER_UTIL': '"1"',
      'process.env.WS_NO_UTF_8_VALIDATE': '"1"'
    },
    ssr: { noExternal: true },
    build: {
      ssr: join(root, 'scripts/custom/codex-web/server.ts'),
      outDir: stage,
      emptyOutDir: false,
      minify: false,
      rollupOptions: {
        external: ['bufferutil', 'utf-8-validate'],
        output: { format: 'cjs', entryFileNames: 'server.cjs' }
      }
    }
  })
  for (const file of ['start.sh', 'start.cmd']) {
    const contents = await readFile(join(root, 'scripts/custom/codex-web', file), 'utf8')
    await writeFile(join(stage, file), contents.replace(/\r\n/g, '\n'))
  }
  await chmod(join(stage, 'start.sh'), 0o755)
  await copyFile(join(root, 'LICENSE'), join(stage, 'LICENSE'))
  await copyFile(join(root, 'docs/custom/codex-web-standalone.md'), join(stage, 'README.md'))
  const notices: string[] = []
  for (const directory of [...packages].sort()) {
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    const files = (await readdir(directory)).filter((file) =>
      /^(licen[sc]e|copying|notice)(\.|$)/i.test(file)
    )
    const texts = await Promise.all(files.map((file) => readFile(join(directory, file), 'utf8')))
    notices.push(
      `${pkg.name} ${pkg.version} (${pkg.license || 'see license below'})\n${texts.join('\n')}`
    )
  }
  await writeFile(join(stage, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n\n----------------\n\n'))
  const output = join(root, 'dist')
  await mkdir(output, { recursive: true })
  const archive = async (folder: string): Promise<void> => {
    const file = join(output, `${folder}.tar.gz`)
    await createTar(
      {
        cwd: temporary,
        file,
        gzip: true,
        portable: true,
        onWriteEntry(entry) {
          if (
            entry.stat &&
            (entry.path.endsWith('/start.sh') || entry.path.endsWith('/runtime/node'))
          ) {
            entry.stat.mode = 0o100755
          }
        }
      },
      [folder]
    )
    console.log(`Created ${file}`)
  }
  await archive(name)
  if (includeMac) {
    const macName = `sparkle-codex-web-${version}-macos-arm64`
    const macStage = join(temporary, macName)
    await cp(stage, macStage, { recursive: true })
    const format = execFileSync('file', [process.execPath], { encoding: 'utf8' })
    if (!format.includes('Mach-O 64-bit executable arm64'))
      throw new Error(`Unexpected Node binary: ${format}`)
    const libraries = execFileSync('otool', ['-L', process.execPath], { encoding: 'utf8' })
    for (const line of libraries.trim().split('\n').slice(1)) {
      if (!/^\s+\/(usr\/lib|System\/Library)\//.test(line)) {
        throw new Error(`Node depends on a non-system library: ${line}`)
      }
    }
    const runtime = join(macStage, 'runtime')
    await mkdir(runtime)
    await copyFile(process.execPath, join(runtime, 'node'))
    await chmod(join(runtime, 'node'), 0o755)
    await copyFile(join(dirname(dirname(process.execPath)), 'LICENSE'), join(runtime, 'LICENSE'))
    await writeFile(join(runtime, 'VERSION'), `${process.version}\n`)
    await archive(macName)
  }
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
