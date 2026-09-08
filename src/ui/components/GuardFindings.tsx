import type { GuardFinding } from '@engine/guard'
import { getSession } from '../state'
import { mask } from '../format'
import { Modal } from './Modal'
import { t } from '@i18n/index'

export function GuardFindings(props: {
  findings: GuardFinding[]
  onBind: (f: GuardFinding) => void
  onAllowOnce: (f: GuardFinding) => void
  onAllowAlways: (f: GuardFinding) => void
  onClose: () => void
}) {
  const session = getSession()
  const passLabel = (p: 1 | 2 | 3) => (p === 1 ? t('exit.guardPass1') : p === 2 ? t('exit.guardPass2') : t('exit.guardPass3'))
  return (
    <Modal title={t('exit.guardTitle')} onClose={props.onClose} danger>
      <ul class="cv-list">
        {props.findings.map((f, i) => {
          const field = f.fieldId ? session.getField(f.fieldId) : undefined
          const secret = field ? field.kind === 'password' || field.kind === 'apiKey' || field.kind === 'blob' : f.kind === 'password' || f.kind === 'apiKey'
          return (
            <li key={i} class={`cv-row cv-row-guard-${f.pass}`}>
              <div class="cv-row-main">
                <span class={`cv-chip cv-chip-pass${f.pass}`}>{passLabel(f.pass)}</span>
                <span class="cv-row-line">{t('common.line', { n: f.line + 1 })}</span>
                <code class="cv-row-literal">{secret ? mask(f.matched) : f.matched.length > 60 ? f.matched.slice(0, 60) + '…' : f.matched}</code>
              </div>
              <div class="cv-row-meta cv-muted">{f.reason}</div>
              <div class="cv-row-actions">
                {f.pass !== 3 && (
                  <button type="button" class="cv-btn cv-btn-small cv-btn-primary" onClick={() => props.onBind(f)}>
                    {t('exit.guardBind')}
                  </button>
                )}
                {f.allowlistable && (
                  <>
                    <button type="button" class="cv-btn cv-btn-small" onClick={() => props.onAllowOnce(f)}>
                      {t('exit.guardAllowOnce')}
                    </button>
                    <button type="button" class="cv-btn cv-btn-small cv-btn-ghost" onClick={() => props.onAllowAlways(f)}>
                      {t('exit.guardAllowAlways')}
                    </button>
                  </>
                )}
              </div>
            </li>
          )
        })}
      </ul>
      <div class="cv-actions">
        <button type="button" class="cv-btn" onClick={props.onClose}>
          {t('common.close')}
        </button>
      </div>
    </Modal>
  )
}
