import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import type { CodexDirectoryListing } from '../../../shared/codex-web'

const limit = 5000

export async function workingDirectory(value: unknown): Promise<string> {
  if (typeof value !== 'string' || !value || value.length > 4096 || !isAbsolute(value))
    throw new Error('请选择工作目录的绝对路径')
  const path = resolve(value)
  try {
    if (!(await stat(path)).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new Error('目录不存在或无法访问')
  }
  return path
}

export async function listDirectories(
  value: unknown,
  knownPaths: unknown[] = []
): Promise<CodexDirectoryListing> {
  const home = homedir()
  const path = await workingDirectory(value === undefined || value === '' ? home : value)
  let children
  try {
    children = await readdir(path, { withFileTypes: true })
  } catch {
    throw new Error('无法读取此目录，请确认访问权限')
  }
  const links = children.filter((entry) => entry.isSymbolicLink())
  const linkedDirectories = new Set<string>()
  for (let i = 0; i < links.length; i += 16) {
    await Promise.all(
      links.slice(i, i + 16).map(async (entry) => {
        if ((await stat(join(path, entry.name)).catch(() => null))?.isDirectory())
          linkedDirectories.add(entry.name)
      })
    )
  }
  const entries = children
    .filter((entry) => entry.isDirectory() || linkedDirectories.has(entry.name))
    .map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  const roots = [
    ...new Set(
      [home, process.cwd(), path, ...knownPaths]
        .filter((item): item is string => typeof item === 'string' && isAbsolute(item))
        .map((item) => parse(item).root)
        .filter(Boolean)
    )
  ]
  const parent = dirname(path)
  return {
    path,
    parent: parent === path ? null : parent,
    home,
    roots,
    entries: entries.slice(0, limit),
    truncated: entries.length > limit
  }
}
