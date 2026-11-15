import { createReadStream } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileLocation } from '../../../shared/codex-web-links'

const previewLimit = 512 * 1024
const inlineTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf'
}
const within = (root: string, path: string): boolean => {
  const child = relative(root, path)
  return !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`)
}

export async function projectPath(root: string, value: string, base?: string): Promise<string> {
  const location = fileLocation(value)
  if (!location) throw Object.assign(new Error('文件路径无效'), { status: 400 })
  const realRoot = await realpath(root)
  const working = base ? await realpath(base) : realRoot
  if (!within(realRoot, working))
    throw Object.assign(new Error('此路径不在当前项目内'), { status: 403 })
  const path = await realpath(resolve(working, location.path))
  if (!within(realRoot, path))
    throw Object.assign(new Error('此路径不在当前项目内'), { status: 403 })
  return path
}

export async function serveProjectFile(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  query: URLSearchParams
): Promise<void> {
  try {
    const value = query.get('path') || ''
    const path = await projectPath(root, value, query.get('base') || undefined)
    const info = await stat(path)
    const route = (mode: string): string => {
      const params = new URLSearchParams(query)
      params.set('mode', mode)
      return `/api/file?${params}`
    }
    if (query.get('mode') === 'raw' || query.get('mode') === 'download') {
      if (!info.isFile()) throw Object.assign(new Error('请选择文件'), { status: 400 })
      const type = inlineTypes[extname(path).toLowerCase()]
      const download = query.get('mode') === 'download' || !type
      res.setHeader('Content-Type', download ? 'application/octet-stream' : type)
      res.setHeader(
        'Content-Disposition',
        `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(basename(path))}`
      )
      res.setHeader('Content-Length', info.size)
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      const stream = createReadStream(path)
      stream.on('error', () => res.destroy())
      res.once('close', () => stream.destroy())
      stream.pipe(res)
      return
    }
    let result: Record<string, unknown> = {
      path,
      name: basename(path),
      size: info.size,
      downloadUrl: route('download')
    }
    if (info.isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true })
      const parent = dirname(path)
      result = {
        ...result,
        kind: 'directory',
        parent: parent !== path && within(await realpath(root), parent) ? parent : null,
        entries: entries
          .sort(
            (a, b) =>
              Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)
          )
          .slice(0, 1000)
          .map((entry) => ({
            name: entry.name,
            path: resolve(path, entry.name),
            directory: entry.isDirectory()
          })),
        truncated: entries.length > 1000
      }
    } else if (info.isFile()) {
      const type = inlineTypes[extname(path).toLowerCase()]
      if (type)
        result = {
          ...result,
          kind: type === 'application/pdf' ? 'pdf' : 'image',
          rawUrl: route('raw')
        }
      else {
        const file = await open(path, 'r')
        try {
          const bytes = Buffer.alloc(Math.min(previewLimit, info.size))
          const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
          const binary = bytes.subarray(0, Math.min(bytesRead, 8192)).includes(0)
          result = {
            ...result,
            kind: binary ? 'download' : 'text',
            text: binary ? undefined : bytes.subarray(0, bytesRead).toString('utf8'),
            truncated: info.size > bytesRead
          }
        } finally {
          await file.close()
        }
      }
    } else throw Object.assign(new Error('不支持此文件类型'), { status: 400 })
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(result))
  } catch (error) {
    const code = (error as { code?: string }).code
    const status =
      (error as { status?: number }).status ||
      (code === 'ENOENT' ? 404 : code === 'EACCES' ? 403 : 400)
    res
      .writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      .end(
        JSON.stringify({ error: status === 404 ? '文件或目录不存在' : (error as Error).message })
      )
  }
}
