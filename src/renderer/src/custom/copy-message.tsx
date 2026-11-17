import { useEffect, useRef, useState } from 'react'
import './copy-message.css'

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      /* LAN HTTP and browser policy can require the selection fallback. */
    }
  }
  const focused = document.activeElement
  const selection = window.getSelection(),
    ranges = selection
      ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange())
      : []
  const input = document.createElement('textarea')
  input.value = text
  input.readOnly = true
  input.style.cssText =
    'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none'
  document.body.append(input)
  try {
    input.focus({ preventScroll: true })
    input.select()
    input.setSelectionRange(0, text.length)
    if (!document.execCommand('copy')) throw new Error('复制失败，请重试')
  } finally {
    input.remove()
    selection?.removeAllRanges()
    for (const range of ranges) selection?.addRange(range)
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true })
  }
}
export function CopyMessage({
  text,
  load
}: {
  text: string
  load?: () => Promise<string>
}): React.JSX.Element {
  const [state, setState] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle')
  const [prepared, setPrepared] = useState<string>()
  const [preparing, setPreparing] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const loader = useRef(load)
  loader.current = load
  const needsLoad = !!load
  const retry = useRef<() => void>(() => {})
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      clearTimeout(timer.current)
    }
  }, [])
  useEffect(() => {
    setPrepared(undefined)
    setPreparing(false)
    if (!needsLoad || !button.current) return
    let disposed = false,
      started = false
    const prepare = (): void => {
      if (started) return
      started = true
      setPreparing(true)
      void loader.current!().then(
        (value) => {
          if (!disposed) {
            setPrepared(value)
            setPreparing(false)
            setState('idle')
          }
        },
        () => {
          if (!disposed) {
            started = false
            setPreparing(false)
            setState('error')
          }
        }
      )
    }
    retry.current = prepare
    // Safari requires the HTTP selection fallback to run in the click itself.
    // Fetch deferred text only when its copy button becomes visible.
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        prepare()
        observer.disconnect()
      }
    })
    observer.observe(button.current)
    return () => {
      disposed = true
      observer.disconnect()
    }
  }, [needsLoad, text])
  const copy = async (): Promise<void> => {
    if (state === 'copying') return
    if (needsLoad && prepared === undefined) {
      retry.current()
      return
    }
    setState('copying')
    try {
      await copyText(prepared ?? text)
      if (mounted.current) setState('copied')
    } catch {
      if (mounted.current) setState('error')
    }
    if (mounted.current) {
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setState('idle'), 2200)
    }
  }
  const label =
    state === 'copied' ? '已复制' : state === 'error' ? '复制失败，点击重试' : '复制消息'
  return (
    <button
      ref={button}
      type="button"
      className="copy-message"
      data-keep-composer
      aria-label={label}
      title={label}
      disabled={
        preparing ||
        state === 'copying' ||
        (needsLoad && prepared === undefined && state !== 'error')
      }
      onPointerDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.stopPropagation()
        void copy()
      }}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {state === 'copied' ? (
          <path d="m5 12 4 4L19 6" />
        ) : state === 'error' ? (
          <>
            <path d="m7 7 10 10M17 7 7 17" />
          </>
        ) : (
          <>
            <rect x="8" y="8" width="12" height="13" rx="2" />
            <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
          </>
        )}
      </svg>
      <span className="copy-message-status" aria-live="polite">
        {state === 'copied' ? '已复制' : state === 'error' ? '复制失败' : ''}
      </span>
    </button>
  )
}
