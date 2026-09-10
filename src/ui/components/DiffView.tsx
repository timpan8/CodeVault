import { useEffect, useMemo, useState } from 'preact/hooks'
import { guard } from '@engine/guard'
import { render } from '@engine/template'
import type { ScriptRecord, VersionRecord } from '@vault/model'
import { getSession, toast } from '../state'
import { diffDoc, diffStats, formatStats, markersToExamples } from '../diff'
import { DiffOptionControls, DiffPanes, defaultDiffOptions, type DiffOptions } from './DiffPanes'
import { t } from '@i18n/index'

const REAL_REVERT_S = 60

/**
 * Comparing two stored versions. Everything version-shaped lives here — picking
 * A and B, the stats, and the guarded exits; DiffPanes only draws two documents.
 */
export function DiffView(props: { script: ScriptRecord; versions: VersionRecord[]; aId: string; bId: string; onChangeA: (id: string) => void; onChangeB: (id: string) => void }) {
  const session = getSession()
  const [options, setOptions] = useState<DiffOptions>(defaultDiffOptions)
  const [showReal, setShowReal] = useState(false)
  const [realLeft, setRealLeft] = useState(0)
  const fields = useMemo(() => session.fieldMap(), [])
  const a = props.versions.find((v) => v.id === props.aId)
  const b = props.versions.find((v) => v.id === props.bId)

  const docs = useMemo(() => {
    if (!a || !b) return { a: '', b: '' }
    if (showReal) {
      const real = session.snapshot().real
      return {
        a: render(a.segments, 'real', { fields, real, plain: props.script.language === 'plain' }).text,
        b: render(b.segments, 'real', { fields, real, plain: props.script.language === 'plain' }).text,
      }
    }
    return { a: diffDoc(a.segments, fields), b: diffDoc(b.segments, fields) }
  }, [a, b, showReal, fields])

  const stats = useMemo(() => (a && b ? diffStats(diffDoc(a.segments, fields), diffDoc(b.segments, fields)) : null), [a, b, fields])

  useEffect(() => {
    if (!showReal) return
    setRealLeft(REAL_REVERT_S)
    const id = setInterval(() => {
      setRealLeft((s) => {
        if (s <= 1) {
          setShowReal(false)
          return 0
        }
        return s - 1
      })
    }, 1000)
    return () => clearInterval(id)
  }, [showReal])

  /** One contract for both panes: the text to copy, or null to refuse. */
  const onCopyText = (selected: string): string | null => {
    if (showReal) {
      toast(t('diff.copyBlocked'), 'error')
      return null
    }
    const text = markersToExamples(selected, fields.values())
    const snap = session.snapshot(props.script.id)
    const g = guard({ text, fields: snap.all, real: snap.real, retired: snap.retired, allowlist: snap.allowlist, ns: snap.ns, language: props.script.language })
    if (g.blocked) {
      toast(t('exit.copyForAiBlocked', { n: g.findings.length }), 'error')
      return null
    }
    return text
  }

  const label = (v: VersionRecord) => `v${v.seq}${props.script.stableVersionId === v.id ? ' ★' : ''}${v.note ? ` · ${v.note}` : ''}`

  return (
    <div class="cv-diff">
      <div class="cv-diff-controls">
        <label class="cv-label-inline">
          {t('diff.a')}
          <select class="cv-input cv-input-small" value={props.aId} onChange={(e) => props.onChangeA((e.currentTarget as HTMLSelectElement).value)}>
            {props.versions.map((v) => (
              <option key={v.id} value={v.id}>
                {label(v)}
              </option>
            ))}
          </select>
        </label>
        <label class="cv-label-inline">
          {t('diff.b')}
          <select class="cv-input cv-input-small" value={props.bId} onChange={(e) => props.onChangeB((e.currentTarget as HTMLSelectElement).value)}>
            {props.versions.map((v) => (
              <option key={v.id} value={v.id}>
                {label(v)}
              </option>
            ))}
          </select>
        </label>
        {stats && <span class="cv-chip">{t('diff.stats', { added: stats.added, removed: stats.removed })}</span>}
        <DiffOptionControls value={options} onChange={setOptions} />
        <button type="button" class={`cv-btn cv-btn-small ${showReal ? 'cv-btn-real-armed' : ''}`} onClick={() => setShowReal(!showReal)}>
          {showReal ? '🔓' : '🔒'} {t('diff.showReal')}
        </button>
      </div>
      {showReal && <div class="cv-banner cv-banner-error">{t('diff.realBanner', { s: realLeft })}</div>}
      <DiffPanes docA={docs.a} docB={docs.b} options={options} onCopyText={onCopyText} />
      {stats && <p class="cv-muted cv-small">{formatStats(stats)}</p>}
    </div>
  )
}
