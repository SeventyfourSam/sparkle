import { useEffect } from 'react'

export function usePageGestures(): void {
  useEffect(() => {
    const gesture = (event: Event): void => event.preventDefault()
    const touch = (event: TouchEvent): void => {
      if (event.touches.length > 1) event.preventDefault()
    }
    const options = { passive: false }
    const gestures = ['gesturestart', 'gesturechange', 'gestureend']
    for (const name of gestures) document.addEventListener(name, gesture, options)
    document.addEventListener('touchstart', touch, options)
    document.addEventListener('touchmove', touch, options)
    return () => {
      for (const name of gestures) document.removeEventListener(name, gesture)
      document.removeEventListener('touchstart', touch)
      document.removeEventListener('touchmove', touch)
    }
  }, [])
}
