import { useState } from 'preact/hooks'
import { FIELD_KINDS, type FieldKind } from '@engine/types'
import { masksByDefault } from '@engine/fields'
import type { FieldRecord, PresetRecord } from '@vault/model'
import { ExampleInvalidError } from '@vault/session'
import { getSession, toast, useTick } from '../state'
import { kindLabel, mask } from '../format'
import { FieldForm } from '../components/FieldForm'
import { Modal } from '../components/Modal'
import { Reveal } from '../components/Reveal'
import { t, type StringKey } from '@i18n/index'

/**
 * The two sides of a field, split into the lists you actually think in: what is
 * yours, what the AI is allowed to see, and what applies everywhere. The AI list
 * also holds the preset library the field form picks from.
 */
export function Values() {
  useTick()
  const session = getSession()
  const [editId, setEditId] = useState<string | null>(null)
  const all = session.listFields(true).filter((f) => !f.tombstone)
  const personal = all.filter((f) => session.realValue(f.id) !== undefined)
  const universal = all.filter((f) => f.scope === 'global')

  return (
    <div class="cv-page cv-values">
      <h2>{t('values.title')}</h2>
      <PersonalSection fields={personal} onEdit={setEditId} />
      <AiSection fields={all} />
      <UniversalSection fields={universal} onEdit={setEditId} />
      {editId && (
        <Modal title={t('field.edit')} onClose={() => setEditId(null)}>
          <FieldForm initial={{}} editFieldId={editId} onDone={() => setEditId(null)} onCancel={() => setEditId(null)} />
        </Modal>
      )}
    </div>
  )
}

/** The real value, shown or hidden by the one masking rule. */
function RealCell({ field }: { field: FieldRecord }) {
  const session = getSession()
  const [revealed, setRevealed] = useState(false)
  const real = session.realValue(field.id)
  if (real === undefined) return <span class="cv-warn">{t('field.noReal')}</span>
  if (!masksByDefault(field)) return <code class="cv-field-realvalue">{real}</code>
  return (
    <span class="cv-field-real" onContextMenu={(e) => e.preventDefault()}>
      {revealed ? (
        <Reveal value={real} onDone={() => setRevealed(false)} />
      ) : (
        <>
          <code>{mask(real)}</code>
          <button type="button" class="cv-btn cv-btn-small cv-btn-ghost" onClick={() => setRevealed(true)}>
            {t('field.reveal')}
          </button>
        </>
      )}
    </span>
  )
}

function FieldTable(props: { fields: FieldRecord[]; onEdit: (id: string) => void; extra?: (f: FieldRecord) => preact.ComponentChildren }) {
  const session = getSession()
  return (
    <table class="cv-table">
      <thead>
        <tr>
          <th>{t('values.columnField')}</th>
          <th>{t('field.kind')}</th>
          <th>{t('values.columnReal')}</th>
          <th>{t('field.example')}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {props.fields.map((f) => (
          <tr key={f.id}>
            <td>
              <strong>{f.name}</strong>
              <div class="cv-muted cv-small">{t('values.usedIn', { n: session.fieldUsage(f.id).length })}</div>
            </td>
            <td>{kindLabel(f.kind)}</td>
            <td>
              <RealCell field={f} />
            </td>
            <td>
              <code>{f.example.length > 40 ? f.example.slice(0, 40) + '…' : f.example}</code>
            </td>
            <td class="cv-row-actions">
              <button type="button" class="cv-btn cv-btn-small cv-btn-ghost" onClick={() => props.onEdit(f.id)}>
                {t('field.edit')}
              </button>
              {props.extra?.(f)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function PersonalSection(props: { fields: FieldRecord[]; onEdit: (id: string) => void }) {
  return (
    <section class="cv-card">
      <h3>{t('values.personal')}</h3>
      <p class="cv-muted">{t('values.personalIntro')}</p>
      {props.fields.length === 0 ? (
        <p class="cv-muted">{t('values.noRealYet')}</p>
      ) : (
        <FieldTable fields={props.fields} onEdit={props.onEdit} />
      )}
    </section>
  )
}

function UniversalSection(props: { fields: FieldRecord[]; onEdit: (id: string) => void }) {
  const session = getSession()
  const scripted = session
    .listFields(true)
    .filter((f) => !f.tombstone && f.scope !== 'global')

  const makeGlobal = async (id: string) => {
    try {
      await session.updateField(id, { scope: 'global' })
      toast(t('toast.saved'), 'ok')
    } catch (e) {
      toast(t('common.error', { message: e instanceof Error ? e.message : String(e) }), 'error')
    }
  }

  return (
    <section class="cv-card">
      <h3>{t('values.universal')}</h3>
      <p class="cv-muted">{t('values.universalIntro')}</p>
      {props.fields.length === 0 ? <p class="cv-muted">{t('values.empty')}</p> : <FieldTable fields={props.fields} onEdit={props.onEdit} />}
      {scripted.length > 0 && (
        <>
          <h4>{t('field.scopeScript')}</h4>
          <FieldTable
            fields={scripted}
            onEdit={props.onEdit}
            extra={(f) => (
              <button type="button" class="cv-btn cv-btn-small" onClick={() => void makeGlobal(f.id)}>
                {t('values.makeGlobal')}
              </button>
            )}
          />
        </>
      )}
    </section>
  )
}

function AiSection({ fields }: { fields: FieldRecord[] }) {
  const session = getSession()
  const presets = session.listPresets()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<FieldKind>('server')
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  const problems = value.trim() ? session.validatePresetValue(value, kind) : []

  const save = async (input: { name: string; kind: FieldKind; value: string }) => {
    try {
      await session.createPreset(input)
      toast(t('values.presetSaved'), 'ok')
      setName('')
      setValue('')
      setError(null)
    } catch (e) {
      if (e instanceof ExampleInvalidError) setError(e.problems.map((p) => t(`field.exampleProblem.${p}` as StringKey)).join(' '))
      else setError(e instanceof Error ? e.message : String(e))
    }
  }

  const del = async (p: PresetRecord) => {
    await session.deletePreset(p.id)
  }

  return (
    <section class="cv-card">
      <h3>{t('values.ai')}</h3>
      <p class="cv-muted">{t('values.aiIntro')}</p>

      <h4>{t('values.aiInUse')}</h4>
      {fields.length === 0 ? (
        <p class="cv-muted">{t('values.empty')}</p>
      ) : (
        <ul class="cv-list cv-list-compact">
          {fields.map((f) => (
            <li key={f.id} class="cv-row">
              <div class="cv-row-main">
                <span class={`cv-chip cv-kind-${f.kind}`}>{kindLabel(f.kind)}</span>
                <code class="cv-row-literal">{f.example}</code>
                <span class="cv-row-field">{f.name}</span>
              </div>
              {!presets.some((p) => p.kind === f.kind && p.value.toLowerCase() === f.example.toLowerCase()) && (
                <div class="cv-row-actions">
                  <button type="button" class="cv-btn cv-btn-small cv-btn-ghost" onClick={() => void save({ name: f.name, kind: f.kind, value: f.example })}>
                    {t('values.saveAsPreset')}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <h4>{t('values.aiLibrary')}</h4>
      {presets.length === 0 ? (
        <p class="cv-muted">{t('values.empty')}</p>
      ) : (
        <ul class="cv-list cv-list-compact">
          {presets.map((p) => (
            <li key={p.id} class="cv-row">
              <div class="cv-row-main">
                <span class={`cv-chip cv-kind-${p.kind}`}>{kindLabel(p.kind)}</span>
                <code class="cv-row-literal">{p.value}</code>
                <span class="cv-row-field">{p.name}</span>
              </div>
              <div class="cv-row-actions">
                <button type="button" class="cv-btn cv-btn-small cv-btn-ghost cv-btn-danger" onClick={() => void del(p)}>
                  {t('values.deletePreset')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <form
        class="cv-form cv-preset-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (!value.trim() || problems.length > 0) return
          void save({ name: name.trim() || value.trim(), kind, value: value.trim() })
        }}
      >
        <h4>{t('values.addPreset')}</h4>
        <div class="cv-grid-2">
          <label class="cv-label">
            {t('values.presetName')}
            <input class="cv-input" value={name} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} spellcheck={false} autocomplete="off" />
          </label>
          <label class="cv-label">
            {t('field.kind')}
            <select class="cv-input" value={kind} onChange={(e) => setKind((e.currentTarget as HTMLSelectElement).value as FieldKind)}>
              {FIELD_KINDS.map((k) => (
                <option value={k} key={k}>
                  {kindLabel(k)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label class="cv-label">
          {t('values.presetValue')}
          <input class="cv-input" value={value} onInput={(e) => setValue((e.currentTarget as HTMLInputElement).value)} spellcheck={false} autocomplete="off" />
          {problems.length > 0 && <span class="cv-hint cv-warn">{problems.map((p) => t(`field.exampleProblem.${p}` as StringKey)).join(' ')}</span>}
        </label>
        {error && <div class="cv-callout cv-callout-error">{error}</div>}
        <div class="cv-actions">
          <button type="submit" class="cv-btn cv-btn-primary" disabled={!value.trim() || problems.length > 0}>
            {t('values.savePreset')}
          </button>
        </div>
      </form>
    </section>
  )
}
