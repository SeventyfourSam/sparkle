import { useEffect, useRef, useState } from 'react'

// Mobile browsers can blur a textarea with no relatedTarget before a button's
// click, or while the keyboard/viewport changes. End editing only on user intent.
export function useComposerEditing(): {
  ref: React.RefObject<HTMLDivElement | null>
  editing: boolean
  finish: () => void
} {
  const ref = useRef<HTMLDivElement>(null)
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    const inside = (target: EventTarget | null): boolean =>
      target instanceof Node && !!ref.current?.contains(target)
    const pointer = (event: PointerEvent): void => setEditing(inside(event.target))
    const focus = (event: FocusEvent): void => {
      if (event.target !== document.body && event.target !== document.documentElement)
        setEditing(inside(event.target))
    }
    document.addEventListener('pointerdown', pointer, true)
    document.addEventListener('focusin', focus, true)
    return () => {
      document.removeEventListener('pointerdown', pointer, true)
      document.removeEventListener('focusin', focus, true)
    }
  }, [])
  return {
    ref,
    editing,
    finish: () => {
      setEditing(false)
      const focused = document.activeElement
      if (focused instanceof HTMLElement && ref.current?.contains(focused)) focused.blur()
    }
  }
}
