import { resolve } from 'node:path'
import { runStandalone, standaloneError } from '../../src/main/custom/codex-web/standalone'

runStandalone(
  resolve(import.meta.dirname, '../../out/renderer'),
  process.env.npm_package_version || 'standalone'
).catch(standaloneError)
