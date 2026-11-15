let worker: Worker | undefined
let sequence = 0
const calls = new Map<
  number,
  { resolve: (html: string) => void; reject: () => void; timer: ReturnType<typeof setTimeout> }
>()
export function highlightAsync(
  text: string,
  language: string
): { result: Promise<string>; cancel: () => void } {
  if (!worker) {
    worker = new Worker(new URL('./syntax-worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (
      event: MessageEvent<{ id: number; html: string; error?: boolean }>
    ): void => {
      const call = calls.get(event.data.id)
      if (!call) return
      clearTimeout(call.timer)
      calls.delete(event.data.id)
      if (event.data.error) call.reject()
      else call.resolve(event.data.html)
    }
    worker.onerror = () => {
      for (const call of calls.values()) {
        clearTimeout(call.timer)
        call.reject()
      }
      calls.clear()
      worker?.terminate()
      worker = undefined
    }
  }
  const id = ++sequence
  const result = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      calls.delete(id)
      reject(new Error('高亮超时'))
    }, 15000)
    calls.set(id, { resolve, reject: () => reject(new Error('无法高亮')), timer })
    worker!.postMessage({ id, text, language })
  })
  return {
    result,
    cancel: () => {
      const call = calls.get(id)
      if (call) {
        clearTimeout(call.timer)
        calls.delete(id)
      }
    }
  }
}
