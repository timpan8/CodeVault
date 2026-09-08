import { useState } from 'preact/hooks'
import type { ScriptRecord, VersionRecord } from '@vault/model'
import { getSession, toast } from '../state'
import { relativeTime } from '../format'
import { t, type StringKey } from '@i18n/index'

export function VersionList(props: { script: ScriptRecord; versions: VersionRecord[]; selectedId: string | undefined; onSelect: (id: string) => void }) {
  const session = getSession()
  const [editingNote, setEditingNote] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const latest = props.versions[props.versions.length - 1]

  const badge = (v: VersionRecord) => {
    const ids = new Set(v.segments.filter((s) => s.t === 'slot').map((s) => (s as { fieldId: string }).fieldId))
    const missing = v.reviewLog.filter((e) => e.status === 'missing' && !e.acknowledgedBy).length
    if (missing > 0) return { text: t('script.fieldsMissing', { done: ids.size, total: ids.size + missing, missing }), cls: 'cv-badge-bad' }
    return { text: t('script.fieldsOk', { n: ids.size }), cls: 'cv-badge-ok' }
  }

  const toggleStable = async (v: VersionRecord) => {
    await session.updateScript(props.script.id, { stableVersionId: props.script.stableVersionId === v.id ? undefined : v.id })
  }

  const restore = async (v: VersionRecord) => {
    const nv = await session.addVersion({
      scriptId: props.script.id,
      segments: v.segments,
      source: 'restore',
      eol: v.eol,
      parentVersionId: v.id,
      note: t('script.restored', { seq: v.seq }),
      tags: [],
      reviewLog: v.reviewLog,
      needsReview: v.needsReview,
    })
    props.onSelect(nv.id)
  }

  const remove = async (v: VersionRecord) => {
    if (!confirm(t('script.deleteVersionConfirm', { seq: v.seq }))) return
    try {
      await session.deleteVersion(v.id)
      if (props.selectedId === v.id && latest) props.onSelect(latest.id === v.id ? props.versions[props.versions.length - 2]!.id : latest.id)
    } catch (e) {
      toast(t('common.error', { message: e instanceof Error ? e.message : String(e) }), 'error')
    }
  }

  const toggleTag = async (v: VersionRecord, tag: string) => {
    const tags = v.tags.includes(tag) ? v.tags.filter((x) => x !== tag) : [...v.tags, tag]
    await session.updateVersion(v.id, { tags })
  }

  return (
    <div class="cv-version-list">
      <h3>{t('script.versions')}</h3>
      <ul class="cv-list cv-list-compact">
        {[...props.versions].reverse().map((v) => {
          const b = badge(v)
          const selected = v.id === props.selectedId
          const stable = props.script.stableVersionId === v.id
          return (
            <li key={v.id} class={`cv-version ${selected ? 'cv-version-selected' : ''}`}>
              <button type="button" class="cv-version-btn" onClick={() => props.onSelect(v.id)}>
                <span class="cv-version-seq">
                  v{v.seq} {stable && <span title={t('scripts.stable')}>★</span>}
                </span>
                <span class="cv-muted">{relativeTime(v.createdAt)}</span>
                <span class={`cv-chip cv-chip-src-${v.source}`}>{t(`script.source.${v.source}` as StringKey)}</span>
                <span class={`cv-badge ${b.cls}`}>{b.text}</span>
                {v.needsReview && <span class="cv-chip cv-chip-warn">{t('script.needsReview')}</span>}
                {v.tags.map((tag) => (
                  <span key={tag} class={`cv-chip cv-chip-tag-${tag}`}>
                    {t(`script.tag.${tag}` as StringKey)}
                  </span>
                ))}
                {v.note && editingNote !== v.id && <span class="cv-version-note">{v.note}</span>}
              </button>
              {selected && (
                <div class="cv-version-actions">
                  {editingNote === v.id ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault()
                        void session.updateVersion(v.id, { note: noteDraft }).then(() => setEditingNote(null))
                      }}
                    >
                      <input class="cv-input cv-input-small" value={noteDraft} onInput={(e) => setNoteDraft((e.currentTarget as HTMLInputElement).value)} autoFocus spellcheck={false} placeholder={t('script.note')} />
                    </form>
                  ) : (
                    <button
                      type="button"
                      class="cv-btn cv-btn-small cv-btn-ghost"
                      onClick={() => {
                        setNoteDraft(v.note ?? '')
                        setEditingNote(v.id)
                      }}
                    >
                      ✎ {t('script.note')}
                    </button>
                  )}
                  <button type="button" class="cv-btn cv-btn-small cv-btn-ghost" onClick={() => void toggleStable(v)}>
                    {stable ? t('script.unsetStable') : t('script.setStable')}
                  </button>
                  <button type="button" class="cv-btn cv-btn-small cv-btn-ghost" onClick={() => void toggleTag(v, 'broken')}>
                    {t('script.tag.broken')}
                  </button>
                  <button type="button" class="cv-btn cv-btn-small cv-btn-ghost" onClick={() => void toggleTag(v, 'experiment')}>
                    {t('script.tag.experiment')}
                  </button>
                  {latest && latest.id !== v.id && (
                    <button type="button" class="cv-btn cv-btn-small" onClick={() => void restore(v)}>
                      {t('script.restore')}
                    </button>
                  )}
                  {props.versions.length > 1 && !stable && (
                    <button type="button" class="cv-btn cv-btn-small cv-btn-danger" onClick={() => void remove(v)}>
                      {t('script.deleteVersion')}
                    </button>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
