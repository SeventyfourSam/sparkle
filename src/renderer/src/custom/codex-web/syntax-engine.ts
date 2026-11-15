import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import go from 'highlight.js/lib/languages/go'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import java from 'highlight.js/lib/languages/java'
import kotlin from 'highlight.js/lib/languages/kotlin'
import swift from 'highlight.js/lib/languages/swift'
import ruby from 'highlight.js/lib/languages/ruby'
import php from 'highlight.js/lib/languages/php'
import bash from 'highlight.js/lib/languages/bash'
import powershell from 'highlight.js/lib/languages/powershell'
import dos from 'highlight.js/lib/languages/dos'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import scss from 'highlight.js/lib/languages/scss'
import less from 'highlight.js/lib/languages/less'
import json from 'highlight.js/lib/languages/json'
import yaml from 'highlight.js/lib/languages/yaml'
import ini from 'highlight.js/lib/languages/ini'
import sql from 'highlight.js/lib/languages/sql'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import makefile from 'highlight.js/lib/languages/makefile'
import markdown from 'highlight.js/lib/languages/markdown'
import lua from 'highlight.js/lib/languages/lua'
import r from 'highlight.js/lib/languages/r'
import perl from 'highlight.js/lib/languages/perl'
import { codeLanguage, escapedSource } from '../../../../shared/codex-web-file-formats'

for (const [name, grammar] of Object.entries({
  javascript,
  typescript,
  python,
  rust,
  go,
  cpp,
  csharp,
  java,
  kotlin,
  swift,
  ruby,
  php,
  bash,
  powershell,
  dos,
  xml,
  css,
  scss,
  less,
  json,
  yaml,
  ini,
  sql,
  diff,
  dockerfile,
  makefile,
  markdown,
  lua,
  r,
  perl
}))
  hljs.registerLanguage(name, grammar)
export function highlightSource(text: string, language: string): string {
  const name = codeLanguage(language)
  return name
    ? hljs.highlight(text, { language: name, ignoreIllegals: true }).value
    : escapedSource(text)
}
