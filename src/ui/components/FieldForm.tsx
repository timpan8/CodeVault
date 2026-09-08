import { useMemo, useState } from 'preact/hooks'
import { FIELD_KINDS, type Field, type FieldKind } from '@engine/types'
import { generateExample } from '@engine/examples'
import { buildBlobExample } from '@engine/blob'
import { matchRuleFor, suggestFieldName } from '@engine/fields'
import { directoryPart } from '../review'
import type { FieldRecord } from '@vault/model'
import { ExampleInvalidError } from '@vault/session'
import { getSession, toast } from '../state'
import { kindLabel } from '../format'
import { SecretInput } from './SecretInput'
import { t } from '@i18n/index'

export interface FieldFormInitial {
  name?: string
  kind?: FieldKind
  real?: string
  scope?: Field['scope']
  bindingName?: string
  /** Raw text of a table block (blob fields). */
  blobRaw?: string
}

export function FieldForm(props: {
  initial: FieldFormInitial
  scriptId?: string
  editFieldId?: string
  requireReal?: boolean
  onDone: (field: FieldRecord) => void
  onLink?: (field: FieldRecord) => void
  onCancel: () => void
}) {
  const session = getSession()
  const editing = props.editFieldId ? session.getField(props.editFieldId) : undefined
  const [kind, setKind] = useState<FieldKind>(editing?.kind ?? props.initial.kind ?? 'custom')
  const [name, setName] = useState(editing?.name ?? props.initial.name ?? suggestFieldName(props.initial.kind ?? 'custom', props.initial.bindingName))
  const [real, setReal] = useState(
    (props.initial.kind === 'path' && props.initial.real ? directoryPart(props.initial.real) : props.initial.real) ?? (editing ? (session.realValue(editing.id) ?? '') : ''),
  )
  const [derive, setDerive] = useState(true)
  const [scope, setScope] = useState<Field['scope']>(editing?.scope ?? props.initial.scope ?? 'global')
  const [rootPath, setRootPath] = useState(session.getSettings().rootPath ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const namespace = session.namespace()
  const examplePreview = useMemo(() => {
    if (editing) return editing.example
    if (kind === 'blob') return buildBlobExample(props.initial.blobRaw ?? real, session.listFields(true).filter((f) => f.kind === 'blob').length + 1, namespace)
    const n = session.listFields(true).filter((f) => f.kind === kind).length + 1
    return generateExample(kind, n, namespace, real ? { shapeOf: real } : {})
  }, [kind, real, editing])

  const duplicate = useMemo(() => {
    if (!real || editing) return undefined
    const f = session.findFieldByRealValue(real)
    return f && f.id !== props.editFieldId ? f : undefined
  }, [real])

  const needsRoot = kind === 'path' && !session.getSettings().rootPath
  const tooShort = real !== '' && matchRuleFor(real) === 'anchor-only'
  const effectiveRoot = (session.getSettings().rootPath ?? rootPath).trim().replace(/[\\/]+$/, '')
  const canDerive =
    kind === 'path' && !editing && effectiveRoot.length > 2 && real.toLowerCase().startsWith(effectiveRoot.toLowerCase() + '\\') && real.length > effectiveRoot.length + 1
  const derivedRest = canDerive ? real.slice(effectiveRoot.length + 1) : ''

  const submit = async () => {
    if (busy) return
    if (!name.trim()) return
    if (props.requireReal && !real) return
    setBusy(true)
    setError(null)
    try {
      if (needsRoot && rootPath.trim()) await session.updateSettings({ rootPath: rootPath.trim() })
      let rec: FieldRecord
      let template: string | undefined
      if (canDerive && derive) {
        // Ensure the global ROOT field exists, then derive this field from it.
        let root = session.listFields().find((f) => f.kind === 'path' && f.name === 'ROOT')
        if (!root) root = await session.createField({ name: 'ROOT', kind: 'path', real: effectiveRoot, scope: 'global', example: namespace.pathRoot })
        template = `{{ROOT}}\\${derivedRest}`
      }
      if (editing) {
        rec = await session.updateField(editing.id, {
          name: name.trim(),
          kind,
          scope,
          ...(real !== (session.realValue(editing.id) ?? '') ? { real } : {}),
        })
      } else {
        rec = await session.createField({
          name: name.trim(),
          kind,
          ...(real ? { real } : {}),
          scope,
          ...(props.initial.bindingName ? { nameAnchors: [props.initial.bindingName] } : {}),
          ...(kind === 'blob' ? { example: examplePreview } : {}),
          ...(template ? { template } : {}),
        })
      }
      props.onDone(rec)
    } catch (e) {
      if (e instanceof ExampleInvalidError) setError(e.problems.join(', '))
      else setError(e instanceof Error ? e.message : String(e))
      toast(t('common.error', { message: e instanceof Error ? e.message : String(e) }), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      class="cv-form"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <label class="cv-label">
        {t('field.name')}
        <input class="cv-input" value={name} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))} autoFocus spellcheck={false} autocomplete="off" />
      </label>
      <label class="cv-label">
        {t('field.kind')}
        <select class="cv-input" value={kind} onChange={(e) => setKind((e.currentTarget as HTMLSelectElement).value as FieldKind)} disabled={props.initial.blobRaw !== undefined}>
          {FIELD_KINDS.map((k) => (
            <option value={k} key={k}>
              {kindLabel(k)}
            </option>
          ))}
        </select>
      </label>
      {kind !== 'blob' ? (
        <label class="cv-label">
          {t('field.real')} {props.requireReal ? '*' : ''}
          <SecretInput value={real} onInput={setReal} ariaLabel={t('field.real')} />
          <span class="cv-hint">{t('field.realHint')}</span>
          {tooShort && <span class="cv-hint cv-warn">{t('field.tooShort')}</span>}
        </label>
      ) : (
        <div class="cv-label">
          {t('field.real')}
          <pre class="cv-pre cv-pre-small">{(props.initial.blobRaw ?? real).split('\n').length} lines (block)</pre>
        </div>
      )}
      {duplicate && (
        <div class="cv-callout cv-callout-warn">
          {t('field.duplicateReal', { name: duplicate.name })}{' '}
          {props.onLink && (
            <button type="button" class="cv-btn cv-btn-small" onClick={() => props.onLink!(duplicate)}>
              {t('paste.linkField')}
            </button>
          )}
        </div>
      )}
      <div class="cv-label">
        {t('field.example')}
        <pre class="cv-pre cv-pre-small">{examplePreview}</pre>
        <span class="cv-hint">{t('field.exampleGenerated')}</span>
      </div>
      <label class="cv-label">
        {t('field.scope')}
        <select class="cv-input" value={scope === 'global' ? 'global' : 'script'} onChange={(e) => setScope((e.currentTarget as HTMLSelectElement).value === 'global' || !props.scriptId ? 'global' : `script:${props.scriptId}`)}>
          <option value="global">{t('field.scopeGlobal')}</option>
          {props.scriptId && <option value="script">{t('field.scopeScript')}</option>}
        </select>
      </label>
      {canDerive && (
        <label class="cv-check">
          <input type="checkbox" checked={derive} onChange={() => setDerive(!derive)} /> {t('field.deriveFromRoot', { rest: derivedRest })}
          <span class="cv-hint">{t('field.deriveHint')}</span>
        </label>
      )}
      {needsRoot && (
        <label class="cv-label">
          {t('field.rootPath')}
          <input class="cv-input" value={rootPath} onInput={(e) => setRootPath((e.currentTarget as HTMLInputElement).value)} placeholder="C:\Temp" spellcheck={false} />
          <span class="cv-hint">{t('field.rootPathHint')}</span>
        </label>
      )}
      {error && <div class="cv-callout cv-callout-error">{error}</div>}
      <div class="cv-actions">
        <button type="submit" class="cv-btn cv-btn-primary" disabled={busy || !name.trim() || (props.requireReal === true && !real)}>
          {editing ? t('field.update') : t('field.create')}
        </button>
        <button type="button" class="cv-btn" onClick={props.onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  )
}
