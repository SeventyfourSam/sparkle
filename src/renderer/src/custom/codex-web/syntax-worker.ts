import { highlightSource } from './syntax-engine'
self.onmessage = (event: MessageEvent<{ id: number; text: string; language: string }>): void => {
  const { id, text, language } = event.data
  try {
    self.postMessage({ id, html: highlightSource(text, language) })
  } catch {
    self.postMessage({ id, error: true })
  }
}
