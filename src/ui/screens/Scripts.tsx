import { useState } from 'preact/hooks'
import { getSession, navigate, toast, useTick } from '../state'
import { PasteSheet } from '../components/PasteSheet'
import { relativeTime } from '../format'
import { t } from '@i18n/index'

export function Scripts() {
  useTick()
  const session = getSession()
  const scripts = session.listScripts()
  const [pasting, setPasting] = useState(scripts.length === 0)

  const remove = async (id: string, title: string, n: number) => {
    if (!confirm(t('scripts.deleteConfirm', { title, n }))) return
    await session.deleteScript(id)
    toast(t('toast.saved'), 'ok')
  }

  return (
    <div class="cv-page">
      <div class="cv-page-head">
        <h2>{t('scripts.title')}</h2>
        {!pasting && (
          <button type="button" class="cv-btn cv-btn-primary" onClick={() => setPasting(true)}>
            {t('scripts.new')}
          </button>
        )}
      </div>
      {scripts.length === 0 && <p class="cv-muted">{t('scripts.empty')}</p>}
      <ul class="cv-list cv-script-list">
        {scripts.map((s) => {
          const versions = session.listVersions(s.id)
          const latest = versions[versions.length - 1]
          return (
            <li key={s.id} class="cv-row cv-script-row">
              <button type="button" class="cv-script-open" onClick={() => navigate({ view: 'script', scriptId: s.id })}>
                <strong>{s.title}</strong>
                <span class="cv-muted">
                  {versions.length === 1 ? t('scripts.version') : t('scripts.versions', { n: versions.length })} · {relativeTime(s.updatedAt)}
                  {s.stableVersionId && <> · ★ {t('scripts.stable')}</>}
                  {latest?.needsReview && <span class="cv-chip cv-chip-warn"> {t('script.needsReview')}</span>}
                </span>
              </button>
              <button type="button" class="cv-btn cv-btn-small cv-btn-ghost cv-btn-danger" onClick={() => void remove(s.id, s.title, versions.length)}>
                {t('scripts.delete')}
              </button>
            </li>
          )
        })}
      </ul>
      {pasting && (
        <section class="cv-card cv-card-wide">
          <h3>{t('scripts.pasteHint')}</h3>
          <PasteSheet
            onDone={(sid, vid) => {
              setPasting(false)
              navigate({ view: 'script', scriptId: sid, versionId: vid })
            }}
            onCancel={() => setPasting(false)}
          />
        </section>
      )}
    </div>
  )
}
