const aliases: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  py: 'python',
  pyi: 'python',
  rs: 'rust',
  golang: 'go',
  c: 'cpp',
  h: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  kt: 'kotlin',
  kts: 'kotlin',
  rb: 'ruby',
  sh: 'bash',
  zsh: 'bash',
  shell: 'bash',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  bat: 'dos',
  cmd: 'dos',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  vue: 'xml',
  svelte: 'xml',
  xhtml: 'xml',
  jsonc: 'json',
  webmanifest: 'json',
  yml: 'yaml',
  toml: 'ini',
  conf: 'ini',
  env: 'ini',
  md: 'markdown',
  mdown: 'markdown',
  mdx: 'markdown',
  patch: 'diff',
  docker: 'dockerfile',
  mk: 'makefile'
}
const supported = new Set([
  'javascript',
  'typescript',
  'python',
  'rust',
  'go',
  'cpp',
  'csharp',
  'java',
  'kotlin',
  'swift',
  'ruby',
  'php',
  'bash',
  'powershell',
  'dos',
  'xml',
  'css',
  'scss',
  'less',
  'json',
  'yaml',
  'ini',
  'sql',
  'diff',
  'dockerfile',
  'makefile',
  'markdown',
  'lua',
  'r',
  'perl'
])
export function codeLanguage(value: string): string | undefined {
  const name = value
    .trim()
    .toLowerCase()
    .replace(/^language-/, '')
  const language = aliases[name] || name
  return supported.has(language) ? language : undefined
}
export function fileFormat(name: string): {
  kind: 'markdown' | 'source' | 'text'
  language?: string
} {
  const base = name.replace(/\\/g, '/').split('/').at(-1)!.toLowerCase()
  const extension = base.split('.').at(-1)!
  if (['md', 'markdown', 'mdown', 'mdx'].includes(extension))
    return { kind: 'markdown', language: 'markdown' }
  const language = /^dockerfile(?:\.|$)/.test(base)
    ? 'dockerfile'
    : /^makefile(?:\.|$)/.test(base)
      ? 'makefile'
      : base === '.env' || base.startsWith('.env.')
        ? 'ini'
        : codeLanguage(extension)
  return language ? { kind: 'source', language } : { kind: 'text' }
}
export function normalizeSource(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}
export const escapedSource = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
export function sourceSelection(
  text: string,
  line: number,
  column: number
): { start: number; end: number; columnStart?: number } | undefined {
  if (!Number.isSafeInteger(line) || line < 1) return
  let start = 0
  for (let index = 1; index < line; index++) {
    const next = text.indexOf('\n', start)
    if (next < 0) return
    start = next + 1
  }
  const next = text.indexOf('\n', start)
  const end = next < 0 ? text.length : next
  return {
    start,
    end,
    columnStart:
      Number.isSafeInteger(column) && column > 0 ? Math.min(end, start + column - 1) : undefined
  }
}
