import { toasts } from '../state'

export function Toasts() {
  const items = toasts.value
  if (items.length === 0) return null
  return (
    <div class="cv-toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} class={`cv-toast cv-toast-${t.kind}`}>
          {t.message}
        </div>
      ))}
    </div>
  )
}
