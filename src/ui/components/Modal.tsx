import type { ComponentChildren } from 'preact'
import { useEffect } from 'preact/hooks'
import { t } from '@i18n/index'

export function Modal(props: { title: string; onClose?: () => void; children: ComponentChildren; wide?: boolean; danger?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && props.onClose) {
        e.stopPropagation()
        props.onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.onClose])
  return (
    <div class="cv-overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose?.()}>
      <div class={`cv-modal ${props.wide ? 'cv-modal-wide' : ''} ${props.danger ? 'cv-modal-danger' : ''}`} role="dialog" aria-modal="true" aria-label={props.title}>
        <header class="cv-modal-header">
          <h2>{props.title}</h2>
          {props.onClose && (
            <button type="button" class="cv-btn cv-btn-ghost" onClick={props.onClose} aria-label={t('common.close')}>
              ×
            </button>
          )}
        </header>
        <div class="cv-modal-body">{props.children}</div>
      </div>
    </div>
  )
}
