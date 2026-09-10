import { useEffect, useState } from 'preact/hooks'
import { t } from '@i18n/index'

/**
 * A masked text input that is NOT type=password: password managers would
 * otherwise offer to save (and sync) the value. Masking is CSS-only.
 *
 * `masked` defaults to true, so every master-password field stays hidden
 * without saying so. A caller passes false for a value that is identifying
 * rather than secret — a server name, a path — which you cannot check against
 * the code while it reads as dots.
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
  masked?: boolean
}) {
  const [shown, setShown] = useState(props.masked === false)
  // The field kind can change under the form (custom -> password), and the
  // value must not stay visible when it does.
  useEffect(() => setShown(props.masked === false), [props.masked])
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
