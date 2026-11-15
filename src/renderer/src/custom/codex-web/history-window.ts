import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { CodexRecord } from '../../../../shared/codex-web'
import { visibleNarrative } from '../../../../shared/codex-web-history'
import { mergeTurns, trimWindow, type Conversation } from './state'
import { HistoryScrollGate } from './history-scroll-gate'

type Target = { instanceId: string; threadId: string }
export interface HistoryPage {
  data: CodexRecord[]
  olderCursor?: string | null
  newerCursor?: string | null
}
export function shiftHistoryPages(
  pages: HistoryPage[],
  page: HistoryPage,
  direction: 'older' | 'newer'
): HistoryPage[] {
  return direction === 'older' ? [page, ...pages].slice(0, 3) : [...pages, page].slice(-3)
}
export function pageTurns(pages: HistoryPage[], offset = 0): CodexRecord[] {
  return trimWindow(
    {
      turns: pages.reduce((all, page) => mergeTurns(all, page.data), [] as CodexRecord[]),
      loading: false,
      browsingHistory: true
    },
    20,
    offset
  ).turns
}
const count = (turns: CodexRecord[]): number =>
  turns.flatMap((turn) => turn.items || []).filter(visibleNarrative).length

export function useHistoryWindow({
  conversation,
  target,
  command,
  scroller,
  nearBottom,
  online,
  adoptLatest
}: {
  conversation: Conversation
  target?: Target
  command: (action: string, params?: CodexRecord) => Promise<CodexRecord>
  scroller: RefObject<HTMLDivElement | null>
  nearBottom: RefObject<boolean>
  online: boolean
  adoptLatest: (turns: CodexRecord[]) => void
}): {
  turns: CodexRecord[]
  browsing: boolean
  loading: boolean
  error: string
  hasOlder: boolean
  older: () => void
  latest: () => void
} {
  const [pages, setPages] = useState<HistoryPage[] | null>(null)
  const [frozen, setFrozen] = useState<CodexRecord[]>()
  const [windowStart, setWindowStart] = useState(0)
  const [loading, setLoading] = useState(false),
    [error, setError] = useState('')
  const [commit, setCommit] = useState(0)
  const gate = useRef(new HistoryScrollGate())
  const generation = useRef(0),
    moving = useRef(false),
    lockedTop = useRef<number | undefined>(undefined)
  const pending = useRef<{ epoch: number; latest: boolean } | undefined>(undefined)
  const anchors = useRef<{ id: string; y: number }[]>([])
  const retryDirection = useRef<'older' | 'newer'>('older')
  const current = useRef({ conversation, target, pages, online, frozen, windowStart, adoptLatest })
  current.current = { conversation, target, pages, online, frozen, windowStart, adoptLatest }
  const targetKey = target ? `${target.instanceId}:${target.threadId}` : ''
  const reset = (): void => {
    generation.current++
    gate.current.reset()
    pending.current = undefined
    moving.current = false
    lockedTop.current = undefined
    anchors.current = []
    scroller.current
      ?.querySelectorAll<HTMLElement>('[data-history-spacer]')
      .forEach((node) => (node.style.height = '0px'))
  }
  useEffect(() => {
    reset()
    setLoading(false)
    setPages(null)
    setWindowStart(0)
    setFrozen(undefined)
    setError('')
  }, [targetKey, conversation.loading])
  const remember = (): void => {
    const node = scroller.current
    if (!node) return
    lockedTop.current = node.scrollTop
    const box = node.getBoundingClientRect()
    anchors.current = [...node.querySelectorAll<HTMLElement>('[data-history-id]')]
      .filter((entry) => {
        const rect = entry.getBoundingClientRect()
        return rect.bottom > box.top && rect.top < box.bottom
      })
      .map((entry) => ({ id: entry.dataset.historyId!, y: entry.getBoundingClientRect().top }))
  }
  useLayoutEffect(() => {
    const batch = pending.current,
      node = scroller.current
    if (!batch || batch.epoch !== generation.current || !node) return
    moving.current = true
    const topSpace = node.querySelector<HTMLElement>('[data-history-spacer="top"]')
    const bottomSpace = node.querySelector<HTMLElement>('[data-history-spacer="bottom"]')
    if (topSpace) topSpace.style.height = '0px'
    if (bottomSpace) bottomSpace.style.height = '0px'
    const restore = (): void => {
      const entries = [...node.querySelectorAll<HTMLElement>('[data-history-id]')]
      for (const anchor of anchors.current) {
        const entry = entries.find((entry) => entry.dataset.historyId === anchor.id)
        if (entry) {
          const desired = node.scrollTop + entry.getBoundingClientRect().top - anchor.y
          if (desired < 0 && topSpace)
            topSpace.style.height = `${parseFloat(topSpace.style.height || '0') - desired}px`
          const maximum = node.scrollHeight - node.clientHeight
          if (desired > maximum && bottomSpace)
            bottomSpace.style.height = `${parseFloat(bottomSpace.style.height || '0') + desired - maximum}px`
          node.scrollTop = Math.max(0, desired)
          break
        }
      }
      lockedTop.current = node.scrollTop
    }
    restore()
    let frame = requestAnimationFrame(() => {
      if (batch.epoch !== generation.current) return
      restore()
      frame = requestAnimationFrame(() => {
        if (batch.epoch !== generation.current) return
        restore()
        anchors.current = []
        pending.current = undefined
        moving.current = false
        gate.current.complete()
        setLoading(false)
        if (batch.latest)
          nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 160
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [commit, scroller, nearBottom])
  const latest = (): void => {
    reset()
    setLoading(false)
    setPages(null)
    setWindowStart(0)
    setFrozen(undefined)
    setError('')
    nearBottom.current = true
    requestAnimationFrame(() => {
      const node = scroller.current
      if (node) node.scrollTop = node.scrollHeight
    })
  }
  const navigate = async (direction: 'older' | 'newer', force = false): Promise<void> => {
    const state = current.current
    if (!state.target || !state.online || state.conversation.loading) return
    if (
      direction === 'older' &&
      state.pages &&
      state.windowStart === 0 &&
      !state.pages[0]?.olderCursor
    )
      return
    if (direction === 'newer' && !state.pages && !state.frozen) return
    if (
      direction === 'older' &&
      !state.pages &&
      !state.conversation.nextCursor &&
      count(state.conversation.turns) <= 10 &&
      !state.conversation.windowTrimmed
    )
      return
    const all = (list: HistoryPage[]): CodexRecord[] =>
      list.reduce((result, page) => mergeTurns(result, page.data), [] as CodexRecord[])
    const range = (list: HistoryPage[]): number => {
      const keys = all(list).flatMap((turn) =>
        (turn.items || [])
          .filter(visibleNarrative)
          .map((item: CodexRecord) => `${turn.id}:${item.id}`)
      )
      const max = Math.max(0, keys.length - 20)
      const node = scroller.current,
        box = node?.getBoundingClientRect()
      const visible =
        node && box
          ? [...node.querySelectorAll<HTMLElement>('[data-history-id]')]
              .filter((item) => {
                const rect = item.getBoundingClientRect()
                return rect.bottom > box.top && rect.top < box.bottom
              })
              .map((item) => item.dataset.historyId!)
          : []
      const key = visible.find((id) => keys.includes(id)),
        index = key ? keys.indexOf(key) : -1
      return direction === 'older'
        ? Math.max(0, index >= 0 ? index - 19 : 0)
        : Math.min(max, index >= 0 ? index : max)
    }
    const total = state.pages ? count(all(state.pages)) : 0
    const cached =
      !!state.pages &&
      (direction === 'older' ? state.windowStart > 0 : state.windowStart + 20 < total)
    if (cached && range(state.pages!) === state.windowStart) return
    if (!gate.current.begin(force)) return
    const epoch = generation.current
    retryDirection.current = direction
    remember()
    nearBottom.current = false
    setLoading(true)
    setError('')
    if (!state.pages && !state.frozen) setFrozen(state.conversation.turns)
    const apply = (next: HistoryPage[] | null, resumeLatest = false): void => {
      if (generation.current !== epoch) return
      pending.current = { epoch, latest: resumeLatest }
      setPages(next)
      setWindowStart(next ? range(next) : 0)
      setFrozen(undefined)
      setCommit((value) => value + 1)
    }
    try {
      if (cached) {
        apply(state.pages)
        return
      }
      if (!state.pages) {
        if (direction === 'newer') {
          apply(null, true)
          return
        }
        const stable = count(state.conversation.turns) <= 10 && !state.conversation.windowTrimmed
        if (stable) {
          const base: HistoryPage = {
            data: state.conversation.turns,
            olderCursor: state.conversation.nextCursor,
            newerCursor: state.conversation.newerCursor
          }
          const older = await command('history', { ...state.target, cursor: base.olderCursor })
          apply(
            older.data.length
              ? shiftHistoryPages([base], older as HistoryPage, 'older')
              : [{ ...base, olderCursor: null }]
          )
        } else {
          const data = state.conversation.turns
          const items = data.flatMap((turn) => turn.items || [])
          const a = items[0],
            b = items.at(-1)
          if (!a || !b) {
            const page = await command('history', state.target)
            apply([page as HistoryPage])
            return
          }
          const older = await command('history', {
            ...state.target,
            before: { turnId: a.webTurnId, itemId: a.id },
            end: { turnId: b.webTurnId, itemId: b.id }
          })
          const base: HistoryPage = {
            data,
            olderCursor: older.windowOlderCursor,
            newerCursor: older.windowNewerCursor
          }
          apply(
            older.data.length
              ? shiftHistoryPages([base], older as HistoryPage, 'older')
              : [{ ...base, data: state.conversation.turns, olderCursor: null }]
          )
        }
      } else {
        const cursor =
          direction === 'older' ? state.pages[0].olderCursor : state.pages.at(-1)?.newerCursor
        if (!cursor) {
          state.adoptLatest(pageTurns(state.pages, Math.max(0, total - 20)))
          apply(null, true)
          return
        }
        const page = await command('history', { ...state.target, cursor })
        apply(shiftHistoryPages(state.pages, page as HistoryPage, direction))
      }
    } catch (error) {
      if (generation.current === epoch) {
        setError((error as Error).message)
        pending.current = { epoch, latest: false }
        setCommit((value) => value + 1)
      }
    }
  }
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate
  useEffect(() => {
    const node = scroller.current
    if (!node) return
    let previous = node.scrollTop,
      touchY: number | undefined,
      intentUntil = 0
    const edge = (direction: 'older' | 'newer'): void => {
      if (moving.current || !gate.current.allowed) return
      const box = node.getBoundingClientRect(),
        entries = node.querySelectorAll<HTMLElement>('[data-history-id]')
      const first = entries[0]?.getBoundingClientRect(),
        last = entries[entries.length - 1]?.getBoundingClientRect()
      if (direction === 'older' && (!first || first.top > box.top - 110))
        void navigateRef.current('older')
      if (
        direction === 'newer' &&
        (!last || last.bottom < box.bottom + 110) &&
        (current.current.pages || current.current.frozen)
      )
        void navigateRef.current('newer')
    }
    const scroll = (): void => {
      if (!gate.current.allowed && !moving.current) {
        if (lockedTop.current !== undefined && Math.abs(node.scrollTop - lockedTop.current) > 0.5)
          node.scrollTop = lockedTop.current
        previous = node.scrollTop
        return
      }
      const value = node.scrollTop,
        delta = value - previous
      previous = value
      if (Math.abs(delta) > 1 && Date.now() < intentUntil) edge(delta < 0 ? 'older' : 'newer')
    }
    const wheel = (event: WheelEvent): void => {
      if (!gate.current.wheel(Date.now())) {
        event.preventDefault()
        return
      }
      intentUntil = Date.now() + 1200
      if (Math.abs(event.deltaY) > 1) edge(event.deltaY < 0 ? 'older' : 'newer')
      if (!gate.current.allowed) event.preventDefault()
    }
    const start = (event: TouchEvent): void => {
      gate.current.touchStart()
      touchY = event.touches.length === 1 ? event.touches[0].clientY : undefined
    }
    const touch = (event: TouchEvent): void => {
      if (!gate.current.allowed) {
        event.preventDefault()
        return
      }
      if (touchY === undefined || event.touches.length !== 1) return
      intentUntil = Date.now() + 1200
      const y = event.touches[0].clientY,
        delta = y - touchY
      touchY = y
      if (Math.abs(delta) > 1) edge(delta > 0 ? 'older' : 'newer')
      if (!gate.current.allowed) event.preventDefault()
    }
    node.addEventListener('scroll', scroll, { passive: true })
    node.addEventListener('wheel', wheel, { passive: false })
    node.addEventListener('touchstart', start, { passive: true })
    node.addEventListener('touchmove', touch, { passive: false })
    return () => {
      node.removeEventListener('scroll', scroll)
      node.removeEventListener('wheel', wheel)
      node.removeEventListener('touchstart', start)
      node.removeEventListener('touchmove', touch)
    }
  }, [targetKey, scroller])
  const historicalTurns = useMemo(
    () => (pages ? pageTurns(pages, windowStart) : undefined),
    [pages, windowStart]
  )
  return {
    turns: historicalTurns || frozen || conversation.turns,
    browsing: !!pages || !!frozen,
    loading,
    error,
    hasOlder: pages
      ? windowStart > 0 || !!pages[0]?.olderCursor
      : !!conversation.nextCursor || count(conversation.turns) > 10,
    older: () => void navigate(retryDirection.current, true),
    latest
  }
}
