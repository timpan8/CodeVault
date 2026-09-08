import { useState } from 'preact/hooks'
import { VaultSession } from '@vault/session'
import { formatRecoveryKey } from '@vault/crypto'
import { APP_VERSION, navigate, setSession, store, toast } from '../state'
import { SecretInput } from '../components/SecretInput'
import { downloadText } from '../format'
import { t } from '@i18n/index'

export function Setup() {
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<{ session: VaultSession; recoveryKey: string } | null>(null)
  const [saved, setSaved] = useState(false)

  const create = async () => {
    setError(null)
    if (pw.length < 10) return setError(t('setup.tooShort'))
    if (pw !== pw2) return setError(t('setup.mismatch'))
    setBusy(true)
    try {
      const created = await VaultSession.create(store, pw, { appVersion: APP_VERSION })
      setPending(created)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const download = () => {
    if (!pending) return
    downloadText('codevault-recovery-key.txt', `CodeVault recovery key\n\n${formatRecoveryKey(pending.recoveryKey)}\n\nKeep this somewhere safe. It opens the vault and lets you set a new master password.\n`)
  }

  const finish = () => {
    if (!pending) return
    setSession(pending.session)
    navigate({ view: 'scripts' })
    toast(t('toast.saved'), 'ok')
  }

  if (pending) {
    return (
      <div class="cv-center">
        <div class="cv-card">
          <h2>{t('setup.recoveryTitle')}</h2>
          <p>{t('setup.recoveryIntro')}</p>
          <pre class="cv-pre cv-recovery" onContextMenu={(e) => e.preventDefault()}>
            {formatRecoveryKey(pending.recoveryKey)}
          </pre>
          <div class="cv-actions">
            <button type="button" class="cv-btn" onClick={download}>
              {t('setup.recoveryDownload')}
            </button>
          </div>
          <label class="cv-check">
            <input type="checkbox" checked={saved} onChange={() => setSaved(!saved)} /> {t('setup.recoverySaved')}
          </label>
          <div class="cv-actions">
            <button type="button" class="cv-btn cv-btn-primary" disabled={!saved} onClick={finish}>
              {t('setup.recoveryContinue')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div class="cv-center">
      <form
        class="cv-card cv-form"
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        <h2>{t('setup.title')}</h2>
        <p class="cv-muted">{t('setup.intro')}</p>
        <label class="cv-label">
          {t('setup.password')}
          <SecretInput value={pw} onInput={setPw} autoFocus ariaLabel={t('setup.password')} />
        </label>
        <label class="cv-label">
          {t('setup.passwordRepeat')}
          <SecretInput value={pw2} onInput={setPw2} ariaLabel={t('setup.passwordRepeat')} onEnter={() => void create()} />
        </label>
        {error && <div class="cv-callout cv-callout-error">{error}</div>}
        <div class="cv-actions">
          <button type="submit" class="cv-btn cv-btn-primary" disabled={busy}>
            {busy ? t('setup.creating') : t('setup.create')}
          </button>
        </div>
      </form>
    </div>
  )
}
