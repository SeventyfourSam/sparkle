import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ClaudeHistoryPage, ClaudeMessage } from '../../../../shared/claude-channel'
import { claudeMessageWindow, isClaudeMessage } from '../../../../shared/claude-channel'
import type { CodexRecord } from '../../../../shared/codex-web'
import { HistoryScrollGate } from '../codex-web/history-scroll-gate'
import { latestMessages, mergeMessages, pageMessages, shiftClaudePages } from './window-state'
export { mergeMessages } from './window-state'

type Command = (action: string, params?: CodexRecord) => Promise<CodexRecord>
export function useClaudeHistory(sessionId: string | undefined, command: Command) {
  const scroller = useRef<HTMLDivElement>(null)
  const [pages, setPages] = useState<ClaudeHistoryPage[]>([])
  const [windowStart, setWindowStart] = useState(0)
  const [loading, setLoading] = useState(false),
    [error, setError] = useState('')
  const [browsing, setBrowsing] = useState(false),
    [atBottom, setAtBottom] = useState(true)
  const [commit, setCommit] = useState(0)
  const gate = useRef(new HistoryScrollGate()),
    epoch = useRef(0)
  const moving = useRef(false),
    lockedTop = useRef<number | undefined>(undefined)
  const anchors = useRef<{ id: string; top: number }[]>([])
  const pending = useRef<'bottom' | 'restore' | undefined>(undefined)
  const current = useRef({ pages, browsing, sessionId, windowStart })
  current.current = { pages, browsing, sessionId, windowStart }
  const bottom = useRef(true)
  const remember = useCallback(() => {
    const node = scroller.current
    if (!node) return
    lockedTop.current = node.scrollTop
    const box = node.getBoundingClientRect()
    anchors.current = [...node.querySelectorAll<HTMLElement>('[data-claude-message]')]
      .filter((item) => {
        const r = item.getBoundingClientRect()
        return r.bottom > box.top && r.top < box.bottom
      })
      .map((item) => ({
        id: item.dataset.claudeMessage!,
        top: item.getBoundingClientRect().top - box.top
      }))
  }, [])
  const restore = useCallback(() => {
    const node = scroller.current
    if (!node) return
    if (pending.current === 'bottom') {
      node.scrollTop = node.scrollHeight
      lockedTop.current = node.scrollTop
      bottom.current = true
      setAtBottom(true)
      return
    }
    const top = node.querySelector<HTMLElement>('[data-claude-spacer="top"]'),
      tail = node.querySelector<HTMLElement>('[data-claude-spacer="bottom"]')
    for (const anchor of anchors.current) {
      const item = [...node.querySelectorAll<HTMLElement>('[data-claude-message]')].find(
        (entry) => entry.dataset.claudeMessage === anchor.id
      )
      if (!item) continue
      const desired =
        node.scrollTop +
        item.getBoundingClientRect().top -
        node.getBoundingClientRect().top -
        anchor.top
      if (desired < 0 && top)
        top.style.height = `${parseFloat(top.style.height || '0') - desired}px`
      const max = node.scrollHeight - node.clientHeight
      if (desired > max && tail)
        tail.style.height = `${parseFloat(tail.style.height || '0') + desired - max}px`
      node.scrollTop = Math.max(0, desired)
      break
    }
    lockedTop.current = node.scrollTop
  }, [])
  useEffect(() => {
    epoch.current++
    gate.current.reset()
    setPages([])
    setWindowStart(0)
    setError('')
    setBrowsing(false)
    setAtBottom(true)
    bottom.current = true
    pending.current = undefined
    anchors.current = []
    return () => {
      epoch.current++
      gate.current.reset()
    }
  }, [sessionId])
  useLayoutEffect(() => {
    if (!pending.current) return
    moving.current = true
    scroller.current
      ?.querySelectorAll<HTMLElement>('[data-claude-spacer]')
      .forEach((item) => (item.style.height = '0px'))
    restore()
    let frame = requestAnimationFrame(() => {
      restore()
      frame = requestAnimationFrame(() => {
        restore()
        pending.current = undefined
        anchors.current = []
        moving.current = false
        gate.current.complete()
        setLoading(false)
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [commit, restore])
  useLayoutEffect(() => {
    if (bottom.current && !current.current.browsing && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight
  }, [pages])
  const apply = useCallback(
    (next: ClaudeHistoryPage[], start: number, mode: 'bottom' | 'restore') => {
      pending.current = mode
      setPages(next)
      setWindowStart(start)
      setCommit((value) => value + 1)
    },
    []
  )
  const latest = useCallback(async () => {
    const generation = ++epoch.current
    if (!sessionId) return
    gate.current.reset()
    gate.current.begin(true)
    setLoading(true)
    setError('')
    try {
      const result = (await command('history', { sessionId })) as ClaudeHistoryPage & {
        recent?: ClaudeMessage[]
      }
      if (epoch.current !== generation) return
      const items = latestMessages(result)
      setBrowsing(false)
      bottom.current = true
      apply([{ ...result, items, before: items[0]?.source || result.before }], 0, 'bottom')
    } catch (error) {
      if (epoch.current === generation) {
        setError((error as Error).message)
        gate.current.complete()
        setLoading(false)
      }
    }
  }, [command, sessionId, apply])
  const refresh = useCallback(async () => {
    if (!sessionId || current.current.browsing || gate.current.loading) return
    if (!bottom.current) {
      setBrowsing(true)
      return
    }
    const generation = epoch.current
    try {
      const result = (await command('history', { sessionId })) as ClaudeHistoryPage & {
        recent?: ClaudeMessage[]
      }
      if (epoch.current !== generation || current.current.browsing || gate.current.loading) return
      const items = latestMessages(result)
      setWindowStart(0)
      setPages([{ ...result, items, before: items[0]?.source || result.before }])
    } catch (error) {
      if (epoch.current === generation) setError((error as Error).message)
    }
  }, [sessionId, command])
  const receive = useCallback((message: ClaudeMessage) => {
    if (current.current.browsing || gate.current.loading) return
    if (!bottom.current) {
      setBrowsing(true)
      return
    }
    setWindowStart(0)
    setPages((old) => {
      const items = mergeMessages(pageMessages(old), [message])
      return [{ items, before: items[0]?.source || old[0]?.before || null, after: null }]
    })
  }, [])
  const navigate = useCallback(
    async (direction: 'before' | 'after', force = false) => {
      const state = current.current
      if (!state.sessionId || !state.pages.length) return
      const all = pageMessages(state.pages),
        before = direction === 'before'
      const windowEnd = state.windowStart + claudeMessageWindow(all.slice(state.windowStart), 20)[1]
      const cached = before ? state.windowStart > 0 : windowEnd < all.length
      const token = before ? state.pages[0].before : state.pages.at(-1)?.after
      if (!cached && !token) {
        if (!before && state.browsing) await latest()
        return
      }
      if (!gate.current.begin(force)) return
      const generation = epoch.current
      remember()
      bottom.current = false
      setLoading(true)
      setError('')
      const range = (next: ClaudeHistoryPage[]): number => {
        const items = pageMessages(next),
          index =
            anchors.current
              .map((anchor) => items.findIndex((item) => item.id === anchor.id))
              .find((i) => i >= 0) ?? -1
        const count = items.filter(isClaudeMessage).length,
          latestStart = claudeMessageWindow(items, 20, Math.max(0, count - 20))[0]
        return before
          ? claudeMessageWindow(
              items,
              20,
              Math.max(0, items.slice(0, index + 1).filter(isClaudeMessage).length - 20)
            )[0]
          : Math.min(latestStart, index >= 0 ? index : latestStart)
      }
      try {
        const next = cached
          ? state.pages
          : shiftClaudePages(
              state.pages,
              (await command('history', {
                sessionId: state.sessionId,
                [direction]: token
              })) as ClaudeHistoryPage,
              before
            )
        if (epoch.current !== generation) return
        setBrowsing(true)
        apply(next, range(next), 'restore')
      } catch (error) {
        if (epoch.current === generation) {
          setError((error as Error).message)
          pending.current = 'restore'
          setCommit((value) => value + 1)
        }
      }
    },
    [command, latest, remember, apply]
  )
  const nav = useRef(navigate)
  nav.current = navigate
  useEffect(() => {
    const node = scroller.current
    if (!node) return
    let y: number | undefined,
      previous = node.scrollTop,
      intent = 0
    const edge = (delta: number) => {
      if (!gate.current.allowed) return
      if (delta < 0 && node.scrollTop < 100) void nav.current('before')
      if (
        delta > 0 &&
        node.scrollHeight - node.scrollTop - node.clientHeight < 100 &&
        current.current.browsing
      )
        void nav.current('after')
    }
    const wheel = (event: WheelEvent) => {
      if (!gate.current.wheel(Date.now())) {
        event.preventDefault()
        return
      }
      intent = Date.now() + 1000
      edge(event.deltaY)
      if (!gate.current.allowed) event.preventDefault()
    }
    const start = (event: TouchEvent) => {
      gate.current.touchStart()
      y = event.touches[0]?.clientY
    }
    const move = (event: TouchEvent) => {
      if (!gate.current.allowed) {
        event.preventDefault()
        return
      }
      const next = event.touches[0]?.clientY
      if (y !== undefined && next !== undefined) {
        intent = Date.now() + 1000
        edge(y - next)
        y = next
      }
      if (!gate.current.allowed) event.preventDefault()
    }
    const scroll = () => {
      if (
        (gate.current.loading || (!gate.current.allowed && Date.now() < intent)) &&
        !moving.current
      ) {
        if (lockedTop.current !== undefined) node.scrollTop = lockedTop.current
        previous = node.scrollTop
        return
      }
      const top = node.scrollTop
      bottom.current = node.scrollHeight - top - node.clientHeight < 70
      setAtBottom(bottom.current)
      if (Date.now() < intent && Math.abs(top - previous) > 1) edge(top - previous)
      previous = top
    }
    node.addEventListener('wheel', wheel, { passive: false })
    node.addEventListener('touchstart', start, { passive: true })
    node.addEventListener('touchmove', move, { passive: false })
    node.addEventListener('scroll', scroll, { passive: true })
    return () => {
      node.removeEventListener('wheel', wheel)
      node.removeEventListener('touchstart', start)
      node.removeEventListener('touchmove', move)
      node.removeEventListener('scroll', scroll)
    }
  }, [sessionId])
  const allItems = pageMessages(pages)
  const windowEnd = windowStart + claudeMessageWindow(allItems.slice(windowStart), 20)[1]
  return {
    scroller,
    items: allItems.slice(windowStart, windowEnd),
    loading,
    error,
    browsing,
    atBottom,
    latest,
    refresh,
    receive,
    older: () => void navigate('before', true),
    hasOlder: windowStart > 0 || !!pages[0]?.before
  }
}
