import { useState } from 'preact/hooks'
import type { FieldRecord } from '@vault/model'
import { getSession, toast } from '../state'
import { kindLabel, mask, shortDate } from '../format'
import { FieldForm } from './FieldForm'
import { Modal } from './Modal'
import { Reveal } from './Reveal'
import { t } from '@i18n/index'

export function FieldsPanel(props: { usedIds: Set<string>; scriptId: string }) {
  const session = getSession()
  const [revealId, setRevealId] = useState<string | null>(null)
  const [editId, setEditId] = useState<string | null>(null)
  const all = session.listFields(true)
  const used = all.filter((f) => props.usedIds.has(f.id))
  const globals = all.filter((f) => !props.usedIds.has(f.id) && !f.tombstone && f.scope === 'global')

  const del = async (f: FieldRecord) => {
    const n = session.fieldUsage(f.id).length
    if (!confirm(t('field.deleteConfirm', { name: f.name, n }))) return
    try {
      await session.deleteField(f.id, n === 0 ? 'hard' : 'hard')
      toast(t('toast.saved'), 'ok')
    } catch (e) {
      toast(t('common.error', { message: e instanceof Error ? e.message : String(e) }), 'error')
    }
  }

  const Row = ({ f }: { f: FieldRecord }) => {
    const real = session.realValue(f.id)
    return (
      <li class={`cv-field ${f.tombstone ? 'cv-field-tombstone' : ''}`}>
        <div class="cv-field-head">
          <strong>{f.name}</strong> <span class={`cv-chip cv-kind-${f.kind}`}>{kindLabel(f.kind)}</span>
          {f.scope !== 'global' && <span class="cv-chip">{t('field.scopeScript')}</span>}
        </div>
        <div class="cv-field-example">
          <code>{f.example.length > 60 ? f.example.slice(0, 60) + '…' : f.example}</code>
        </div>
        <div class="cv-field-real" onContextMenu={(e) => e.preventDefault()}>
          {real === undefined ? (
            <span class="cv-warn">{t('field.noReal')}</span>
          ) : revealId === f.id ? (
            <Reveal value={real} onDone={() => setRevealId(null)} />
          ) : (
            <>
              <code>{mask(real)}</code>
              <button type="button" class="cv-btn cv-btn-small cv-btn-ghost" onClick={() => setRevealId(f.id)}>
                {t('field.reveal')}
              </button>
            </>
          )}
        </div>
        {f.exposedAt && (
          <div class="cv-callout cv-callout-warn cv-small">
            {t('field.exposed', { date: shortDate(f.exposedAt) })}{' '}
            <button type="button" class="cv-btn cv-btn-small" onClick={() => void session.updateField(f.id, { exposedAt: null })}>
              {t('field.markRotated')}
            </button>
          </div>
        )}
        <div class="cv-row-actions">
          <button type="button" class="cv-btn cv-btn-small cv-btn-ghost" onClick={() => setEditId(f.id)}>
            {t('field.edit')}
          </button>
          {!f.tombstone && (
            <button type="button" class="cv-btn cv-btn-small cv-btn-ghost cv-btn-danger" onClick={() => void del(f)}>
              {t('field.delete')}
            </button>
          )}
          <span class="cv-muted cv-small">{t('field.usedIn', { n: session.fieldUsage(f.id).length })}</span>
        </div>
      </li>
    )
  }

  return (
    <div class="cv-fields-panel">
      <h3>{t('field.panelTitle')}</h3>
      <ul class="cv-list cv-list-compact">{used.map((f) => <Row key={f.id} f={f} />)}</ul>
      {globals.length > 0 && (
        <details>
          <summary>{t('field.panelGlobal')} ({globals.length})</summary>
          <ul class="cv-list cv-list-compact">{globals.map((f) => <Row key={f.id} f={f} />)}</ul>
        </details>
      )}
      {editId && (
        <Modal title={t('field.edit')} onClose={() => setEditId(null)}>
          <FieldForm initial={{}} editFieldId={editId} scriptId={props.scriptId} onDone={() => setEditId(null)} onCancel={() => setEditId(null)} />
        </Modal>
      )}
    </div>
  )
}
