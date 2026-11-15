import { resolve } from 'node:path'
import { runStandalone, standaloneError } from '../../../src/main/custom/codex-web/standalone'

declare const __CODEX_WEB_VERSION__: string

runStandalone(resolve(__dirname, 'public'), __CODEX_WEB_VERSION__).catch(standaloneError)
