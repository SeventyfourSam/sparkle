import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)

export function load<T>(file: string, mocks: Record<string, unknown>): T {
  const filename = path.join(import.meta.dirname, file)
  const output = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText
  const module = { exports: {} }
  runInNewContext(output, {
    module,
    exports: module.exports,
    __filename: filename,
    require: (id: string) => (id in mocks ? mocks[id] : require(id)),
    Buffer,
    process,
    structuredClone,
    setTimeout,
    clearTimeout
  })
  return module.exports as T
}
