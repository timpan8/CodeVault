import { useEffect } from 'preact/hooks'

/**
 * Keyboard shortcuts. Only combos the browser does not own: Ctrl+Shift+letter,
 * Alt+letter/arrows. Never Ctrl+Alt (AltGr on Swedish keyboards) and never a
 * shortcut for "copy real".
 */
export type Combo = `ctrl+shift+${string}` | `alt+${string}` | 'escape'

export function matches(e: KeyboardEvent, combo: Combo): boolean {
  const key = e.key.toLowerCase()
  if (combo === 'escape') return key === 'escape'
  if (combo.startsWith('ctrl+shift+')) {
    const k = combo.slice('ctrl+shift+'.length)
    return (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && key === k
  }
  const k = combo.slice('alt+'.length)
  return e.altKey && !e.ctrlKey && !e.metaKey && key === k
}

export function useShortcut(combo: Combo, handler: (e: KeyboardEvent) => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (matches(e, combo)) {
        e.preventDefault()
        handler(e)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [combo, handler, enabled])
}
