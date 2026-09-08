import { useEffect } from 'preact/hooks'
import { getSession, hasSession, lock, navigate, onBeforeLock, phase, route, store, toast, useTick } from './state'
import { clipboardCountdown, clipboardStatus, clearRealClipboard, installClipboardListeners } from './clipboard'
import { writeBackupNow } from './backup'
import { useShortcut } from './keys'
import { Toasts } from './components/Toasts'
import { Setup } from './screens/Setup'
import { Unlock } from './screens/Unlock'
import { Scripts } from './screens/Scripts'
import { ScriptView } from './screens/ScriptView'
import { Sanitize } from './screens/Sanitize'
import { Settings } from './screens/Settings'
import { About } from './screens/About'
import { t } from '@i18n/index'

const SETUP_STEPS = ['backupFolder', 'org'] as const

export function App() {
  useEffect(() => {
    installClipboardListeners()
    void store.exists().then((exists) => {
      phase.value = exists ? 'locked' : 'setup'
    })
    return onBeforeLock(async () => {
      if (!hasSession()) return
      const session = getSession()
      if (!session.changedSinceBackup) return
      const r = await writeBackupNow(session, { allowDownload: false })
      if (!r.ok) toast(t('toast.backupReminder'), 'warn', 6000)
    })
  }, [])

  const p = phase.value
  return (
    <>
      <div class="cv-desktop-only">{t('app.desktopOnly')}</div>
      <div class="cv-shell">
        {p === 'loading' && <div class="cv-center">{t('app.loading')}</div>}
        {p === 'setup' && <Setup />}
        {p === 'locked' && <Unlock />}
        {p === 'unlocked' && <Main />}
        <Toasts />
      </div>
    </>
  )
}

function Main() {
  useTick()
  const session = getSession()
  const r = route.value
  const settings = session.getSettings()
  const done = SETUP_STEPS.filter((s) => settings.setupDone.includes(s)).length
  useShortcut('ctrl+shift+l', () => void lock('manual'))

  return (
    <>
      <header class="cv-header">
        <h1>
          <button type="button" class="cv-linkbtn" onClick={() => navigate({ view: 'scripts' })}>
            {t('app.title')}
          </button>
        </h1>
        <nav class="cv-nav">
          <button type="button" class={`cv-navbtn ${r.view === 'scripts' || r.view === 'script' ? 'cv-navbtn-active' : ''}`} onClick={() => navigate({ view: 'scripts' })}>
            {t('nav.scripts')}
          </button>
          <button type="button" class={`cv-navbtn ${r.view === 'sanitize' ? 'cv-navbtn-active' : ''}`} onClick={() => navigate({ view: 'sanitize' })}>
            {t('nav.sanitize')}
          </button>
          <button type="button" class={`cv-navbtn ${r.view === 'settings' ? 'cv-navbtn-active' : ''}`} onClick={() => navigate({ view: 'settings' })}>
            {t('nav.settings')}
            {done < SETUP_STEPS.length && <span class="cv-chip cv-chip-small"> {t('nav.setupProgress', { done, total: SETUP_STEPS.length })}</span>}
          </button>
          <button type="button" class={`cv-navbtn ${r.view === 'about' ? 'cv-navbtn-active' : ''}`} onClick={() => navigate({ view: 'about' })}>
            {t('nav.about')}
          </button>
        </nav>
        <div class="cv-header-right">
          {session.changedSinceBackup && <span class="cv-chip cv-chip-warn" title={t('nav.backupPending')}>⚠ backup</span>}
          <button type="button" class="cv-btn cv-btn-small" onClick={() => void lock('manual')} title={t('nav.lock')}>
            🔒 {t('nav.lock')}
          </button>
        </div>
      </header>
      <ClipboardBanner />
      <main class="cv-main">
        {r.view === 'scripts' && <Scripts />}
        {r.view === 'script' && <ScriptView scriptId={r.scriptId} versionId={r.versionId} />}
        {r.view === 'sanitize' && <Sanitize />}
        {r.view === 'settings' && <Settings />}
        {r.view === 'about' && <About />}
      </main>
    </>
  )
}

function ClipboardBanner() {
  const status = clipboardStatus.value
  if (status === 'clean') return null
  return (
    <div class={`cv-banner ${status === 'pending-clear' ? 'cv-banner-error' : 'cv-banner-warn'}`} role="status">
      <span>{status === 'real' ? t('exit.banner.real', { s: clipboardCountdown.value }) : t('exit.banner.pending')}</span>
      <button type="button" class="cv-btn cv-btn-small" onClick={() => void clearRealClipboard()}>
        {t('exit.banner.clearNow')}
      </button>
      <span class="cv-muted cv-small">{t('exit.banner.historyNote')}</span>
    </div>
  )
}
