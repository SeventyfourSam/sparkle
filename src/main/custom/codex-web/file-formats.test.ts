import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  fileFormat,
  codeLanguage,
  normalizeSource,
  sourceSelection
} from '../../../shared/codex-web-file-formats'
import { highlightSource } from '../../../renderer/src/custom/codex-web/syntax-engine'

test('file formats select Markdown, source grammars and plain text including named configuration files', () => {
  assert.deepEqual(fileFormat('README.MD'), { kind: 'markdown', language: 'markdown' })
  assert.deepEqual(fileFormat('D:\\work\\view.tsx'), { kind: 'source', language: 'typescript' })
  assert.deepEqual(fileFormat('Dockerfile.dev'), { kind: 'source', language: 'dockerfile' })
  assert.deepEqual(fileFormat('Makefile'), { kind: 'source', language: 'makefile' })
  assert.deepEqual(fileFormat('.env.local'), { kind: 'source', language: 'ini' })
  assert.deepEqual(fileFormat('config.toml'), { kind: 'source', language: 'ini' })
  assert.deepEqual(fileFormat('output.txt'), { kind: 'text' })
  assert.equal(codeLanguage('language-py'), 'python')
  assert.equal(codeLanguage('unrecognized'), undefined)
})

test('registered source grammars highlight common languages and keep markup inert', () => {
  for (const [name, text] of Object.entries({
    typescript: 'export const value: number = 42;',
    javascript: 'const value = "test";',
    python: 'def hello():\n    return True',
    rust: 'fn main() { let value = 42; }',
    go: 'package main\nfunc main() {}',
    json: '{"active":true,"port":38472}',
    yaml: 'enabled: true\nport: 38472',
    ini: '[service]\nport = 38472',
    xml: '<script>alert("unsafe")</script>',
    css: '.item { color: red; }',
    bash: 'echo "hello"',
    powershell: 'Write-Output "hello"',
    sql: 'SELECT * FROM items;',
    dockerfile: 'FROM node:22\nRUN echo "hello"'
  })) {
    const html = highlightSource(text, name)
    assert.ok(html.includes('hljs-'), name)
    assert.equal(/<script[\s>]/i.test(html), false, name)
  }
  assert.equal(
    highlightSource('<img onerror="alert(1)">', 'unknown'),
    '&lt;img onerror="alert(1)"&gt;'
  )
})

test('source selection preserves line and column coordinates after newline normalization', () => {
  const text = normalizeSource('\uFEFFone\r\n\r\nconst value = "test";')
  const selection = sourceSelection(text, 3, 7)!
  assert.equal(text.slice(selection.start, selection.end), 'const value = "test";')
  assert.equal(text[selection.columnStart!], 'v')
  assert.deepEqual(sourceSelection(text, 2, 1), { start: 4, end: 4, columnStart: 4 })
  assert.equal(sourceSelection(text, 99, 1), undefined)
  assert.equal(sourceSelection(text, Infinity, 1), undefined)
})
