import { useMemo, useState } from 'preact/hooks'
import { FIELD_KINDS, type Field, type FieldKind } from '@engine/types'
import { isInExampleNamespace, nextExample } from '@engine/examples'
import { buildBlobExample } from '@engine/blob'
import { kindMasksByDefault, matchRuleFor, suggestFieldName } from '@engine/fields'
import { directoryPart } from '../review'
import type { FieldRecord } from '@vault/model'
import { ExampleInvalidError } from '@vault/session'
import { getSession, toast } from '../state'
import { kindLabel } from '../format'
import { SecretInput } from './SecretInput'
import { t, type StringKey } from '@i18n/index'

export interface FieldFormInitial {
  name?: string
  kind?: FieldKind
  real?: string
  scope?: Field['scope']
  bindingName?: string
  /** Raw text of a table block (blob fields). */
  blobRaw?: string
  /** What the AI itself wrote at this spot; offered as the example value. */
  exampleFromCode?: string
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
  /** The real value in this form is not in the vault yet, so pass it along. */
  const exampleOpts = (forReal: string) => ({
    ...(props.editFieldId ? { exceptId: props.editFieldId } : {}),
    ...(forReal ? { pendingReal: forReal } : {}),
  })
  /** The tool's own suggestion for the current kind and real value. */
  const generated = (forKind: FieldKind, forReal: string): string => {
    if (forKind === 'blob') return buildBlobExample(props.initial.blobRaw ?? forReal, session.listFields(true).filter((f) => f.kind === 'blob').length + 1, namespace)
    return nextExample(
      forKind,
      session.listFields(true),
      namespace,
      forReal ? { shapeOf: forReal } : {},
      (c) => session.validateExampleFor(c, forKind, exampleOpts(forReal)).length === 0,
    )
  }
  const [example, setExample] = useState(() => editing?.example ?? props.initial.exampleFromCode ?? generated(kind, real))
  // Only an untouched field follows the kind; once it is edited it is the user's.
  const [exampleTouched, setExampleTouched] = useState(editing !== undefined || props.initial.exampleFromCode !== undefined)
  const regenerate = (forKind: FieldKind, forReal: string) => {
    if (exampleTouched) return
    setExample(generated(forKind, forReal))
  }

  const exampleProblems = useMemo(
    () => (example.trim() ? session.validateExampleFor(example, kind, exampleOpts(real)) : []),
    [example, kind, real, props.editFieldId],
  )
  const outsideNamespace = example.trim() !== '' && exampleProblems.length === 0 && !isInExampleNamespace(example, namespace)

  /** Saved library values of this kind, offered as a pick-list. */
  const presets = useMemo(() => session.listPresets(kind), [kind])

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
    if (exampleProblems.length > 0) return
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
          ...(example !== editing.example ? { example } : {}),
          ...(real !== (session.realValue(editing.id) ?? '') ? { real } : {}),
        })
      } else {
        rec = await session.createField({
          name: name.trim(),
          kind,
          ...(real ? { real } : {}),
          scope,
          ...(props.initial.bindingName ? { nameAnchors: [props.initial.bindingName] } : {}),
          // Always the value on screen: the form used to discard it for every
          // kind but blob and let createField generate a different one.
          example,
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
        <select
          class="cv-input"
          value={kind}
          onChange={(e) => {
            const next = (e.currentTarget as HTMLSelectElement).value as FieldKind
            setKind(next)
            regenerate(next, real)
          }}
          disabled={props.initial.blobRaw !== undefined}
        >
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
          <SecretInput
            value={real}
            onInput={(v) => {
              setReal(v)
              regenerate(kind, v)
            }}
            ariaLabel={t('field.real')}
            masked={kindMasksByDefault(kind)}
          />
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
        {kind === 'blob' ? (
          // A blob example is a synthetic two-row block, not a value to type.
          <pre class="cv-pre cv-pre-small">{example}</pre>
        ) : (
          <>
            <input
              class="cv-input"
              value={example}
              onInput={(e) => {
                setExampleTouched(true)
                setExample((e.currentTarget as HTMLInputElement).value)
              }}
              spellcheck={false}
              autocomplete="off"
              aria-label={t('field.example')}
            />
            <div class="cv-example-actions">
              <button
                type="button"
                class="cv-btn cv-btn-small"
                onClick={() => {
                  setExampleTouched(false)
                  setExample(generated(kind, real))
                }}
              >
                {t('field.exampleGenerate')}
              </button>
              {presets.length > 0 && (
                <select
                  class="cv-input cv-input-small"
                  value=""
                  onChange={(e) => {
                    const picked = (e.currentTarget as HTMLSelectElement).value
                    if (!picked) return
                    setExampleTouched(true)
                    setExample(picked)
                    e.currentTarget.value = ''
                  }}
                  aria-label={t('field.exampleFromLibrary')}
                >
                  <option value="">{t('field.exampleFromLibrary')}</option>
                  {presets.map((p) => (
                    <option value={p.value} key={p.id}>
                      {p.name} — {p.value}
                    </option>
                  ))}
                </select>
              )}
              {props.initial.exampleFromCode && props.initial.exampleFromCode !== example && (
                <button
                  type="button"
                  class="cv-btn cv-btn-small"
                  onClick={() => {
                    setExampleTouched(true)
                    setExample(props.initial.exampleFromCode!)
                  }}
                >
                  {t('field.exampleFromCode')}
                </button>
              )}
            </div>
          </>
        )}
        <span class="cv-hint">{t('field.exampleHint')}</span>
        {exampleProblems.length > 0 && (
          <span class="cv-hint cv-warn">
            {exampleProblems.map((p) => t(`field.exampleProblem.${p}` as StringKey)).join(' ')}
          </span>
        )}
        {outsideNamespace && <span class="cv-hint cv-warn">{t('field.exampleOutsideNs')}</span>}
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
        <button type="submit" class="cv-btn cv-btn-primary" disabled={busy || !name.trim() || (props.requireReal === true && !real) || exampleProblems.length > 0}>
          {editing ? t('field.update') : t('field.create')}
        </button>
        <button type="button" class="cv-btn" onClick={props.onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  )
}
