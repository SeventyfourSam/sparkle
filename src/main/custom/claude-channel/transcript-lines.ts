import type { FileHandle } from 'node:fs/promises'

export interface TranscriptLine {
  start: number
  end: number
  bytes?: Buffer
}
const chunkSize = 1024 * 1024
const recordLimit = 4 * chunkSize

// Cross arbitrarily long stretches without retaining the transcript in memory.
// An oversized or unfinished record must not hide complete neighbouring records.
export async function* transcriptLines(
  file: FileHandle,
  start: number,
  end: number,
  forward: boolean
): AsyncGenerator<TranscriptLine> {
  let position = forward ? start : end
  let boundary = position
  let pieces: Buffer[] = [],
    length = 0
  let complete = forward
  const add = (piece: Buffer): void => {
    length += piece.length
    if (length <= recordLimit) forward ? pieces.push(piece) : pieces.unshift(piece)
    else pieces = []
  }
  const take = (): Buffer | undefined => {
    const bytes = length <= recordLimit ? Buffer.concat(pieces, length) : undefined
    pieces = []
    length = 0
    return bytes
  }
  while (forward ? position < end : position > start) {
    const from = forward ? position : Math.max(start, position - chunkSize)
    const to = forward ? Math.min(end, position + chunkSize) : position
    const bytes = Buffer.alloc(to - from)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, from)
    if (bytesRead !== bytes.length) throw new Error('历史记录已变化，请重新同步会话')
    if (forward) {
      let at = 0,
        newline: number
      while ((newline = bytes.indexOf(10, at)) >= 0) {
        add(bytes.subarray(at, newline))
        const next = from + newline + 1
        yield { start: boundary, end: next, bytes: take() }
        boundary = next
        at = newline + 1
      }
      add(bytes.subarray(at))
      position = to
    } else {
      let at = bytes.length,
        newline: number
      while ((newline = bytes.lastIndexOf(10, at - 1)) >= 0) {
        add(bytes.subarray(newline + 1, at))
        const next = from + newline + 1
        const value = take()
        if (complete) yield { start: next, end: boundary, bytes: value }
        complete = true
        boundary = next
        at = newline
        if (!at) break
      }
      add(bytes.subarray(0, at))
      position = from
    }
  }
  if (!forward && complete && boundary > start) yield { start, end: boundary, bytes: take() }
}
