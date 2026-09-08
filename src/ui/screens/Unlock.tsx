import { useState } from 'preact/hooks'
import { VaultSession } from '@vault/session'
import { WrongPasswordError } from '@vault/crypto'
import { APP_VERSION, lockReason, navigate, setSession, store } from '../state'
import { ensureBackupPermission } from '../backup'
import { SecretInput } from '../components/SecretInput'
import { t } from '@i18n/index'

export function Unlock() {
  const [pw, setPw] = useState('')
  const [mode, setMode] = useState<'password' | 'recovery'>('password')
  const [key, setKey] = useState('')
  const [newPw, setNewPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const open = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      let session: VaultSession
      if (mode === 'password') {
        session = await VaultSession.open(store, { password: pw }, { appVersion: APP_VERSION })
      } else {
        session = await VaultSession.open(store, { recoveryKey: key }, { appVersion: APP_VERSION })
        if (newPw.length >= 10) await session.changePassword({ recoveryKey: key }, newPw)
      }
      await ensureBackupPermission()
      setSession(session)
      navigate({ view: 'scripts' })
    } catch (e) {
      setError(e instanceof WrongPasswordError ? t('unlock.wrong') : e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setPw('')
    }
  }

  return (
    <div class="cv-center">
      <form
        class="cv-card cv-form"
        onSubmit={(e) => {
          e.preventDefault()
          void open()
        }}
      >
        <h2>{t('unlock.title')}</h2>
        {lockReason.value === 'idle' && <p class="cv-muted">{t('unlock.lockedReason')}</p>}
        {mode === 'password' ? (
          <label class="cv-label">
            {t('unlock.password')}
            <SecretInput value={pw} onInput={setPw} autoFocus ariaLabel={t('unlock.password')} onEnter={() => void open()} />
          </label>
        ) : (
          <>
            <label class="cv-label">
              {t('unlock.recoveryKey')}
              <input class="cv-input" value={key} onInput={(e) => setKey((e.currentTarget as HTMLInputElement).value)} autoFocus spellcheck={false} autocomplete="off" />
            </label>
            <label class="cv-label">
              {t('unlock.newPassword')}
              <SecretInput value={newPw} onInput={setNewPw} ariaLabel={t('unlock.newPassword')} onEnter={() => void open()} />
            </label>
          </>
        )}
        {error && <div class="cv-callout cv-callout-error">{error}</div>}
        <div class="cv-actions">
          <button type="submit" class="cv-btn cv-btn-primary" disabled={busy}>
            {busy ? t('unlock.opening') : mode === 'password' ? t('unlock.open') : t('unlock.resetAndOpen')}
          </button>
          <button type="button" class="cv-btn cv-btn-ghost" onClick={() => setMode(mode === 'password' ? 'recovery' : 'password')}>
            {mode === 'password' ? t('unlock.useRecovery') : t('unlock.usePassword')}
          </button>
        </div>
      </form>
    </div>
  )
}
