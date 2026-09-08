import { useEffect, useState } from 'preact/hooks'

/**
 * Shows a real value for a few seconds as SVG text: not selectable, not a
 * DOM text node, so context menus, drag and extensions cannot lift it.
 */
export function Reveal(props: { value: string; seconds?: number; onDone: () => void }) {
  const total = props.seconds ?? 10
  const [left, setLeft] = useState(total)
  useEffect(() => {
    const id = setInterval(() => setLeft((s) => s - 1), 1000)
    return () => clearInterval(id)
  }, [])
  useEffect(() => {
    if (left <= 0) props.onDone()
  }, [left])
  const width = Math.max(80, props.value.length * 8.5 + 16)
  return (
    <span
      class="cv-reveal"
      onContextMenu={(e) => e.preventDefault()}
      onDragStart={(e) => e.preventDefault()}
      onCopy={(e) => e.preventDefault()}
      title={`${left}s`}
    >
      <svg width={width} height="22" role="img" aria-label="revealed value" style="user-select:none;pointer-events:none">
        <text x="8" y="16" font-family="Consolas, 'Cascadia Mono', monospace" font-size="14" fill="currentColor">
          {props.value}
        </text>
      </svg>
      <span class="cv-reveal-count">{left}</span>
    </span>
  )
}
