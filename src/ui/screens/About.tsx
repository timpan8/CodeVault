import { useState } from 'preact/hooks'
import notices from '../../../THIRD-PARTY-NOTICES.md?raw'
import { APP_VERSION } from '../state'
import { runSelfTest, type SelfTestResult } from '../selftest'
import { t } from '@i18n/index'

export function About() {
  const [result, setResult] = useState<SelfTestResult | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try {
      setResult(await runSelfTest())
    } finally {
      setBusy(false)
    }
  }
  return (
    <div class="cv-page">
      <h2>{t('about.title')}</h2>
      <p class="cv-muted">{t('about.version', { v: APP_VERSION })}</p>
      <section class="cv-card">
        <h3>{t('about.selftest')}</h3>
        <div class="cv-actions">
          <button type="button" class="cv-btn cv-btn-primary" onClick={() => void run()} disabled={busy}>
            {t('about.selftestRun')}
          </button>
          {result && (
            <span class={result.failed.length === 0 ? 'cv-ok' : 'cv-bad'}>
              {result.failed.length === 0 ? t('about.selftestOk', { n: result.total }) : t('about.selftestFail', { failed: result.failed.length, n: result.total })}
            </span>
          )}
        </div>
        {result && result.failed.length > 0 && (
          <ul class="cv-list cv-list-compact">
            {result.failed.map((f) => (
              <li key={f} class="cv-bad">
                {f}
              </li>
            ))}
          </ul>
        )}
      </section>
      <details class="cv-card">
        <summary>{t('about.notices')}</summary>
        <pre class="cv-pre cv-pre-scroll">{notices}</pre>
      </details>
    </div>
  )
}
