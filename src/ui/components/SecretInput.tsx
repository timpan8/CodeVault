import { useState } from 'preact/hooks'
import { t } from '@i18n/index'

/**
 * A masked text input that is NOT type=password: password managers would
 * otherwise offer to save (and sync) the value. Masking is CSS-only.
 */
export function SecretInput(props: {
  value: string
  onInput: (v: string) => void
  placeholder?: string
  autoFocus?: boolean
  id?: string
  onEnter?: () => void
  disabled?: boolean
  ariaLabel?: string
}) {
  const [shown, setShown] = useState(false)
  return (
    <div class="cv-secret-wrap">
      <input
        id={props.id}
        type="text"
        class={`cv-input cv-secret ${shown ? '' : 'cv-secret-masked'}`}
        value={props.value}
        placeholder={props.placeholder}
        autoFocus={props.autoFocus}
        disabled={props.disabled}
        aria-label={props.ariaLabel}
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        spellcheck={false}
        data-lpignore="true"
        data-1p-ignore="true"
        data-bwignore="true"
        onInput={(e) => props.onInput((e.currentTarget as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && props.onEnter) {
            e.preventDefault()
            props.onEnter()
          }
        }}
      />
      <button type="button" class="cv-btn cv-btn-ghost cv-secret-toggle" onClick={() => setShown(!shown)} tabIndex={-1}>
        {shown ? t('common.hide') : t('common.show')}
      </button>
    </div>
  )
}
