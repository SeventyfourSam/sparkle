import { request } from 'node:http'
import { readDescriptor } from './bridge'

// Observers never authorize tools. Loopback delivery ignores proxy variables.
export async function runHook(file: string, id: string): Promise<void> {
  try {
    const chunks: Buffer[] = []
    let size = 0
    for await (const bytes of process.stdin) {
      size += bytes.length
      if (size > 2 * 1024 * 1024) return
      chunks.push(bytes)
    }
    const data = Buffer.concat(chunks)
    const descriptor = await readDescriptor(file)
    await new Promise<void>((resolve, reject) => {
      const req = request(
        descriptor.hookUrl,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${descriptor.token}`,
            'X-Sparkle-Session': id,
            'Content-Type': 'application/json',
            'Content-Length': data.length
          }
        },
        (res) => {
          res.resume()
          res.once('end', () =>
            res.statusCode === 200 ? resolve() : reject(new Error(`HTTP ${res.statusCode}`))
          )
        }
      )
      req.setTimeout(2000, () => req.destroy(new Error('Hook timeout')))
      req.once('error', reject)
      req.end(data)
    })
  } catch {
    /* An unavailable Sparkle must not change Claude's behavior. */
  }
}
