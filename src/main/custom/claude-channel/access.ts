import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import { writeJsonAtomically } from '../codex-web/config'

export const loopback = (address = ''): boolean =>
  address === '::1' || /^(::ffff:)?127\./.test(address)
export const equal = (a: string, b: string): boolean => {
  const left = Buffer.from(a),
    right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
export function sameOrigin(req: IncomingMessage): boolean {
  try {
    return new URL(String(req.headers.origin)).host === req.headers.host
  } catch {
    return false
  }
}
export function localBrowser(req: IncomingMessage): boolean {
  if (!loopback(req.socket.remoteAddress)) return false
  try {
    const hostname = new URL(`http://${req.headers.host}`).hostname
    return (
      ['127.0.0.1', 'localhost', '[::1]'].includes(hostname) &&
      req.headers['sec-fetch-site'] !== 'cross-site'
    )
  } catch {
    return false
  }
}

// The web page is a LAN tool. Only the internal local CLI bridge needs a token;
// the token is generated and passed automatically, never entered by the user.
export class ClaudeAccess {
  private constructor(readonly bridgeToken: string) {}
  static async load(directory: string): Promise<ClaudeAccess> {
    const file = join(directory, 'access.json')
    let value: { bridgeToken: string }
    try {
      value = JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      value = { bridgeToken: randomBytes(32).toString('hex') }
      await writeJsonAtomically(file, value)
    }
    if (!/^[a-f\d]{64}$/.test(value.bridgeToken)) throw new Error('Claude 本机桥接设置无效')
    return new ClaudeAccess(value.bridgeToken)
  }
  trustedBridge(req: IncomingMessage): boolean {
    return (
      loopback(req.socket.remoteAddress) &&
      !req.headers.origin &&
      equal(String(req.headers.authorization || ''), `Bearer ${this.bridgeToken}`)
    )
  }
}
