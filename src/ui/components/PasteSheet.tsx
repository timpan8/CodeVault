import { useState } from 'preact/hooks'
import type { NormalizedPaste } from '@engine/normalize'
import { learnFromAccepted, lineFingerprint, type MissingField, type ReapplyResult, type SlotProposal } from '@engine/reapply'
import { contentHash } from '@engine/template'
import type { FieldKind } from '@engine/types'
import type { FieldRecord } from '@vault/model'
import { engine, getSession, toast, useTick } from '../state'
import { buildVersion, groupRows, initialRows, trimPathRow, type ReviewRow } from '../review'
import { diffDoc, diffStats, formatStats } from '../diff'
import { kindLabel, mask, suggestTitle } from '../format'
import { FieldForm } from './FieldForm'
import { Modal } from './Modal'
import { t, type StringKey } from '@i18n/index'

type Step = 'paste' | 'blocks' | 'review'
type Mode = 'ai' | 'editor'

const SECRET_KINDS = new Set<FieldKind>(['password', 'apiKey', 'blob'])

export function PasteSheet(props: {
  scriptId?: string
  initialMode?: Mode
  onDone: (scriptId: string, versionId: string) => void
  onCancel: () => void
}) {
  useTick()
  const session = getSession()
  const script = props.scriptId ? session.getScript(props.scriptId) : undefined
  const [raw, setRaw] = useState('')
  const [mode, setMode] = useState<Mode>(props.initialMode ?? (props.scriptId ? 'ai' : 'editor'))
  const [step, setStep] = useState<Step>('paste')
  const [normalized, setNormalized] = useState<NormalizedPaste | null>(null)
  const [chosen, setChosen] = useState<number[]>([])
  const [text, setText] = useState('')
  const [result, setResult] = useState<ReapplyResult | null>(null)
  const [rows, setRows] = useState<ReviewRow[]>([])
  const [missingAck, setMissingAck] = useState<Set<string>>(new Set())
  const [title, setTitle] = useState('')
  const [aiVisibleName, setAiVisibleName] = useState('Project01')
  const [language, setLanguage] = useState<'powershell' | 'plain'>(script?.language ?? 'powershell')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [fieldFormFor, setFieldFormFor] = useState<string | null>(null)
  const [linkFor, setLinkFor] = useState<string | null>(null)
  const [directionPrompt, setDirectionPrompt] = useState(false)
  const [duplicateOf, setDuplicateOf] = useState<number | null>(null)
  const [revealed, setRevealed] = useState<Set<string>>(new Set())

  const updateRow = (id: string, patch: Partial<ReviewRow>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  /** Resolve a row to a field; path fields cover the directory prefix only. */
  const resolveRow = (id: string, field: FieldRecord) =>
    setRows((rs) =>
      rs.map((r) => {
        if (r.id !== id) return r
        const next: ReviewRow = { ...r, fieldId: field.id, decision: 'accept', userLinked: true }
        return field.kind === 'path' || field.kind === 'unc' ? trimPathRow(next) : next
      }),
    )

  const analyze = async () => {
    if (!raw.trim()) {
      toast(t('paste.noText'), 'warn')
      return
    }
    setBusy(true)
    try {
      const n = await engine.normalizePaste(raw)
      setNormalized(n)
      let m = mode
      if (n.containedRealSentinel && mode === 'ai') {
        m = 'editor'
        setMode('editor')
        toast(t('paste.realSentinel'), 'warn', 6000)
      }
      if (n.looksLikeTranscript) toast(t('paste.transcript'), 'warn', 6000)
      if (n.blocks.length > 1) {
        let best = 0
        n.blocks.forEach((b, i) => {
          const score = (b.lang && /ps|powershell/i.test(b.lang) ? 1000 : 0) + b.lineCount
          const bestScore = (n.blocks[best]!.lang && /ps|powershell/i.test(n.blocks[best]!.lang!) ? 1000 : 0) + n.blocks[best]!.lineCount
          if (score > bestScore) best = i
        })
        setChosen([best])
        setStep('blocks')
        return
      }
      await runAnalysis(n.blocks[0]?.text ?? '', m)
    } finally {
      setBusy(false)
    }
  }

  const useBlocks = async () => {
    if (!normalized || chosen.length === 0) return
    const parts = [...chosen].sort((a, b) => a - b).map((i) => normalized.blocks[i]!.text)
    setBusy(true)
    try {
      await runAnalysis(parts.join('\n\n'), mode)
    } finally {
      setBusy(false)
    }
  }

  const runAnalysis = async (body: string, m: Mode) => {
    const snap = session.snapshot(props.scriptId)
    const prev = props.scriptId ? session.latestVersion(props.scriptId) : undefined
    const res = await engine.reapply({
      text: body,
      language,
      ...(prev ? { prev: { segments: prev.segments } } : {}),
      fields: snap.own,
      otherFields: snap.other,
      real: [...snap.real],
      retired: snap.retired,
      exclusions: snap.exclusions,
      mode: m,
      ns: snap.ns,
      ...(snap.settings.orgHostRegex ? { orgHostRegex: snap.settings.orgHostRegex } : {}),
    })
    setText(body)
    setResult(res)
    setRows(initialRows(res))
    setMissingAck(new Set())
    setMode(m)
    if (!props.scriptId && !title) setTitle(suggestTitle(body))
    setDirectionPrompt(res.flags.directionWarning && m === 'ai')
    setStep('review')
  }

  const save = async (force = false) => {
    if (!result || !normalized || busy) return
    const now = new Date().toISOString()
    const fields = session.fieldMap()
    const built = buildVersion(text, rows, result.missing, missingAck, fields, now)
    const hash = await contentHash(built.segments)
    let scriptId = props.scriptId
    if (scriptId && !force) {
      const dup = session.findVersionByHash(scriptId, hash)
      if (dup) {
        setDuplicateOf(dup.seq)
        return
      }
    }
    setBusy(true)
    try {
      if (!scriptId) {
        // Real copies use CRLF by default (Windows editors); the paste's own EOL is recorded on the version.
        const s = await session.createScript({ title: title.trim() || suggestTitle(text), aiVisibleName: aiVisibleName.trim() || 'Project01', language, eol: 'crlf' })
        scriptId = s.id
      }
      const prev = session.latestVersion(scriptId)
      let finalNote = note.trim()
      if (!finalNote && prev) finalNote = formatStats(diffStats(diffDoc(prev.segments, fields), diffDoc(built.segments, fields)))
      const version = await session.addVersion({
        scriptId,
        segments: built.segments,
        source: mode === 'editor' ? 'editor' : 'ai',
        eol: normalized.eol,
        ...(prev ? { parentVersionId: prev.id } : {}),
        ...(finalNote ? { note: finalNote } : {}),
        reviewLog: built.reviewLog,
        needsReview: built.needsReview,
      })
      const allExamples = session.listFields(true).map((f) => f.example)
      const realValues = [...session.snapshot().real.values()]
      for (const { proposal, fieldId } of built.accepted) {
        const f = session.getField(fieldId)
        if (!f) continue
        const learned = learnFromAccepted(f, proposal, mode, { otherExamples: allExamples.filter((e) => e !== f.example), realValues })
        const patch: { nameAnchors?: string[]; aliases?: FieldRecord['aliases'] } = {}
        if (learned.nameAnchors.length !== f.nameAnchors.length) patch.nameAnchors = learned.nameAnchors
        if (learned.alias) patch.aliases = [...f.aliases, learned.alias]
        if (Object.keys(patch).length) await session.updateField(fieldId, patch)
      }
      if (mode === 'ai') for (const id of built.exposedFieldIds) await session.updateField(id, { exposedAt: now })
      const lines = text.split('\n')
      for (const r of rows) {
        if (r.kind === 'slot' && r.excluded && r.proposal!.fieldId) {
          await session.addExclusion(scriptId, r.proposal!.fieldId, lineFingerprint(lines[r.proposal!.line] ?? '', r.proposal!.literal))
        }
        if (r.kind === 'unknown' && r.decision === 'safe') await session.addAllowlist(r.unknown!.literal)
      }
      if (built.needsReview) toast(t('paste.needsReview', { n: built.unresolved }), 'warn', 8000)
      props.onDone(scriptId, version.id)
    } catch (e) {
      toast(t('common.error', { message: e instanceof Error ? e.message : String(e) }), 'error')
    } finally {
      setBusy(false)
    }
  }

  const fieldName = (id: string | null) => (id ? (session.getField(id)?.name ?? id) : '')

  const whyText = (p: SlotProposal) =>
    t(`paste.why.${p.why}` as StringKey, { name: p.bindingName ?? '', reason: p.reason ?? '' })

  const warningText = (w: string) => (w.startsWith('remap:') ? t('paste.warn.remap', { name: fieldName(w.slice(6)) }) : t(`paste.warn.${w}` as StringKey))

  const isSecretRow = (row: ReviewRow): boolean => {
    const field = row.fieldId ? session.getField(row.fieldId) : undefined
    if (field) return SECRET_KINDS.has(field.kind)
    const guess = row.proposal?.kindGuess ?? row.unknown?.kindGuess
    return guess !== undefined && SECRET_KINDS.has(guess)
  }

  const literalOf = (row: ReviewRow): string => {
    const lit = row.proposal?.literal ?? row.unknown?.literal ?? ''
    const short = lit.length > 70 ? lit.slice(0, 70) + '…' : lit
    if (isSecretRow(row) && !revealed.has(row.id)) return mask(lit)
    return short
  }

  const RowActions = ({ row }: { row: ReviewRow }) => {
    const p = row.proposal!
    const decided = row.decision !== 'pending'
    return (
      <div class="cv-row-actions">
        {row.fieldId && p.status !== 'auto' && !decided && (
          <button type="button" class="cv-btn cv-btn-small cv-btn-primary" onClick={() => updateRow(row.id, { decision: 'accept' })}>
            {t('paste.accept')}
          </button>
        )}
        {row.fieldId === null && !decided && (
          <>
            <button type="button" class="cv-btn cv-btn-small cv-btn-primary" onClick={() => setFieldFormFor(row.id)}>
              {p.why === 'table' ? t('paste.markBlob') : t('paste.createField')}
            </button>
            <button type="button" class="cv-btn cv-btn-small" onClick={() => setLinkFor(row.id)}>
              {t('paste.linkField')}
            </button>
          </>
        )}
        {row.fieldId !== null && p.status === 'candidate' && p.fromOtherScript && !decided && (
          <button type="button" class="cv-btn cv-btn-small cv-btn-primary" onClick={() => updateRow(row.id, { decision: 'accept', userLinked: true })}>
            {t('paste.linkField')} {fieldName(p.fieldId)}
          </button>
        )}
        {!decided && (
          <button type="button" class="cv-btn cv-btn-small" onClick={() => updateRow(row.id, { decision: 'reject' })}>
            {t('paste.reject')}
          </button>
        )}
        {p.fieldId && row.decision !== 'reject' && (
          <button type="button" class="cv-btn cv-btn-small cv-btn-ghost" onClick={() => updateRow(row.id, { decision: 'reject', excluded: true })}>
            {t('paste.notSecretHere')}
          </button>
        )}
        {decided && (
          <span class={`cv-chip cv-chip-${row.decision}`}>{row.decision === 'accept' ? t('paste.accept') : row.excluded ? t('paste.notSecretHere') : t('paste.reject')}</span>
        )}
        {isSecretRow(row) && (
          <button type="button" class="cv-btn cv-btn-small cv-btn-ghost" onClick={() => setRevealed((s) => new Set(s.has(row.id) ? [...s].filter((x) => x !== row.id) : [...s, row.id]))}>
            {revealed.has(row.id) ? t('common.hide') : t('common.show')}
          </button>
        )}
      </div>
    )
  }

  const SlotRow = ({ row }: { row: ReviewRow }) => {
    const p = row.proposal!
    const field = row.fieldId ? session.getField(row.fieldId) : undefined
    return (
      <li class={`cv-row cv-row-${p.status} ${row.decision === 'reject' ? 'cv-row-rejected' : ''}`}>
        <div class="cv-row-main">
          <span class="cv-row-line">{t('common.line', { n: p.line + 1 })}</span>
          <code class="cv-row-literal">{literalOf(row)}</code>
          <span class="cv-row-field">
            {field ? `→ ${field.name} (${kindLabel(field.kind)})` : p.kindGuess ? `? ${kindLabel(p.kindGuess)}` : ''}
          </span>
        </div>
        <div class="cv-row-meta">
          <span class="cv-muted">{whyText(p)}</span>
          {p.suffix !== undefined && p.suffix !== '' && <span class="cv-muted"> +{p.suffix}</span>}
          {p.columns && <span class="cv-muted"> {t('paste.blobColumns', { cols: p.columns.join(', ') })}</span>}
          {p.warnings.map((w) => (
            <span key={w} class="cv-chip cv-chip-warn">
              {warningText(w)}
            </span>
          ))}
          {p.fromOtherScript && p.fieldId && <span class="cv-muted"> {t('paste.otherScript', { name: fieldName(p.fieldId) })}</span>}
        </div>
        <RowActions row={row} />
      </li>
    )
  }

  const UnknownRow = ({ row }: { row: ReviewRow }) => {
    const u = row.unknown!
    return (
      <li class={`cv-row cv-row-unknown ${row.decision !== 'pending' ? 'cv-row-decided' : ''}`}>
        <div class="cv-row-main">
          <span class="cv-row-line">{t('common.line', { n: u.line + 1 })}</span>
          <code class="cv-row-literal">{literalOf(row)}</code>
          <span class="cv-row-field">{row.fieldId ? `→ ${fieldName(row.fieldId)}` : u.kindGuess ? `? ${kindLabel(u.kindGuess)}` : ''}</span>
        </div>
        <div class="cv-row-meta">
          <span class="cv-muted">{t('paste.unknownReason', { reasons: u.reasons.join(', ') })}</span>
        </div>
        <div class="cv-row-actions">
          {row.decision === 'pending' && (
            <>
              <button type="button" class="cv-btn cv-btn-small cv-btn-primary" onClick={() => setFieldFormFor(row.id)}>
                {t('paste.createField')}
              </button>
              <button type="button" class="cv-btn cv-btn-small" onClick={() => setLinkFor(row.id)}>
                {t('paste.linkField')}
              </button>
              <button type="button" class="cv-btn cv-btn-small" onClick={() => updateRow(row.id, { decision: 'safe' })}>
                {t('paste.markSafe')}
              </button>
              <button type="button" class="cv-btn cv-btn-small cv-btn-ghost" onClick={() => updateRow(row.id, { decision: 'reject' })}>
                {t('paste.ignore')}
              </button>
            </>
          )}
          {row.decision !== 'pending' && <span class={`cv-chip cv-chip-${row.decision}`}>{row.decision === 'accept' ? t('paste.accept') : row.decision === 'safe' ? t('paste.markSafe') : t('paste.ignore')}</span>}
          {isSecretRow(row) && (
            <button type="button" class="cv-btn cv-btn-small cv-btn-ghost" onClick={() => setRevealed((s) => new Set(s.has(row.id) ? [...s].filter((x) => x !== row.id) : [...s, row.id]))}>
              {revealed.has(row.id) ? t('common.hide') : t('common.show')}
            </button>
          )}
        </div>
      </li>
    )
  }

  const MissingRow = ({ m }: { m: MissingField }) => {
    const prev = props.scriptId ? session.latestVersion(props.scriptId) : undefined
    const resolved = rows.some((r) => r.fieldId === m.fieldId && r.decision === 'accept')
    return (
      <li class={`cv-row cv-row-missing ${resolved || missingAck.has(m.fieldId) ? 'cv-row-decided' : ''}`}>
        <div class="cv-row-main">
          <span class="cv-row-field">{fieldName(m.fieldId)}</span>
          <span class="cv-muted">{t('paste.missingHint', { name: fieldName(m.fieldId), seq: prev?.seq ?? 0, lines: m.prevLines.map((l) => l + 1).join(', ') })}</span>
        </div>
        {m.remapCandidates.length > 0 && <div class="cv-row-meta cv-warn">{t('paste.remapHint', { name: m.remapCandidates.map(fieldName).join(', ') })}</div>}
        <div class="cv-row-actions">
          {resolved ? (
            <span class="cv-chip cv-chip-accept">{t('paste.accept')}</span>
          ) : (
            <label class="cv-check">
              <input type="checkbox" checked={missingAck.has(m.fieldId)} onChange={() => setMissingAck((s) => new Set(s.has(m.fieldId) ? [...s].filter((x) => x !== m.fieldId) : [...s, m.fieldId]))} />
              {t('paste.ackRemoved')}
            </label>
          )}
        </div>
      </li>
    )
  }

  const rowForForm = fieldFormFor ? rows.find((r) => r.id === fieldFormFor) : undefined
  const rowForLink = linkFor ? rows.find((r) => r.id === linkFor) : undefined
  const groups = groupRows(rows)
  const blobRaw = rowForForm?.proposal?.why === 'table' ? text.slice(rowForForm.proposal.start, rowForForm.proposal.end) : undefined

  return (
    <div class="cv-paste">
      {step === 'paste' && (
        <div class="cv-paste-step">
          {!props.scriptId && (
            <div class="cv-grid-2">
              <label class="cv-label">
                {t('paste.scriptTitle')}
                <input class="cv-input" value={title} onInput={(e) => setTitle((e.currentTarget as HTMLInputElement).value)} placeholder={t('paste.titleNewScript')} spellcheck={false} />
              </label>
              <label class="cv-label">
                {t('paste.aiVisibleName')}
                <input class="cv-input" value={aiVisibleName} onInput={(e) => setAiVisibleName((e.currentTarget as HTMLInputElement).value)} spellcheck={false} />
              </label>
              <label class="cv-label">
                {t('paste.language')}
                <select class="cv-input" value={language} onChange={(e) => setLanguage((e.currentTarget as HTMLSelectElement).value as 'powershell' | 'plain')}>
                  <option value="powershell">{t('paste.langPowershell')}</option>
                  <option value="plain">{t('paste.langPlain')}</option>
                </select>
              </label>
            </div>
          )}
          <textarea
            class="cv-textarea cv-paste-area"
            placeholder={t('paste.placeholder')}
            value={raw}
            onInput={(e) => setRaw((e.currentTarget as HTMLTextAreaElement).value)}
            spellcheck={false}
            autocomplete="off"
            autoFocus
          />
          <fieldset class="cv-fieldset">
            <legend>{t('paste.modeQuestion')}</legend>
            <label class="cv-check">
              <input type="radio" name="mode" checked={mode === 'editor'} onChange={() => setMode('editor')} /> {t('paste.modeEditor')}
            </label>
            <label class="cv-check">
              <input type="radio" name="mode" checked={mode === 'ai'} onChange={() => setMode('ai')} /> {t('paste.modeAi')}
            </label>
          </fieldset>
          <div class="cv-actions">
            <button type="button" class="cv-btn cv-btn-primary" onClick={() => void analyze()} disabled={busy}>
              {busy ? t('paste.analyzing') : t('paste.analyze')}
            </button>
            <button type="button" class="cv-btn" onClick={props.onCancel}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {step === 'blocks' && normalized && (
        <div class="cv-paste-step">
          <h3>{t('paste.blocksTitle')}</h3>
          <p class="cv-muted">{t('paste.blocksHint')}</p>
          <ul class="cv-list">
            {normalized.blocks.map((b, i) => (
              <li key={i} class="cv-row">
                <label class="cv-check">
                  <input type="checkbox" checked={chosen.includes(i)} onChange={() => setChosen((c) => (c.includes(i) ? c.filter((x) => x !== i) : [...c, i]))} />
                  <strong>{b.lang ?? '–'}</strong> <span class="cv-muted">{t('paste.blockLines', { n: b.lineCount })}</span>
                  <code class="cv-row-literal">{b.text.split('\n')[0]?.slice(0, 80)}</code>
                </label>
              </li>
            ))}
          </ul>
          <div class="cv-actions">
            <button type="button" class="cv-btn cv-btn-primary" onClick={() => void useBlocks()} disabled={busy || chosen.length === 0}>
              {chosen.length > 1 ? t('paste.combine') : t('paste.useBlock')}
            </button>
            <button type="button" class="cv-btn" onClick={() => setStep('paste')}>
              {t('common.back')}
            </button>
          </div>
        </div>
      )}

      {step === 'review' && result && (
        <div class="cv-paste-step cv-review">
          {normalized?.looksPartial && <div class="cv-callout cv-callout-warn">{t('paste.partial')}</div>}
          {directionPrompt && (
            <div class="cv-callout cv-callout-error">
              {t('paste.directionWarning', { n: result.flags.realValuesFound.length + result.flags.retiredFound.length })}
              <div class="cv-actions">
                <button type="button" class="cv-btn cv-btn-primary" onClick={() => void runAnalysis(text, 'editor')}>
                  {t('paste.directionSwitch')}
                </button>
                <button type="button" class="cv-btn" onClick={() => setDirectionPrompt(false)}>
                  {t('paste.directionKeep')}
                </button>
              </div>
            </div>
          )}
          <div class="cv-review-summary">
            {t('paste.summary', { auto: groups.auto.length, confirm: groups.confirm.length, candidate: groups.candidate.length, missing: result.missing.length, unknown: groups.unknown.length })}
            {groups.confirm.some((r) => r.decision === 'pending' && r.fieldId) && (
              <button type="button" class="cv-btn cv-btn-small" onClick={() => setRows((rs) => rs.map((r) => (r.kind === 'slot' && r.proposal!.status === 'auto' ? { ...r, decision: 'accept' } : r)))}>
                {t('paste.acceptAllGreen')}
              </button>
            )}
          </div>

          {groups.unknown.length > 0 && (
            <section class="cv-group cv-group-unknown">
              <h4>{t('paste.groupUnknown', { n: groups.unknown.length })}</h4>
              <ul class="cv-list">{groups.unknown.map((r) => <UnknownRow key={r.id} row={r} />)}</ul>
            </section>
          )}
          {result.missing.length > 0 && (
            <section class="cv-group cv-group-missing">
              <h4>{t('paste.groupMissing', { n: result.missing.length })}</h4>
              <ul class="cv-list">{result.missing.map((m) => <MissingRow key={m.fieldId} m={m} />)}</ul>
            </section>
          )}
          {groups.confirm.length > 0 && (
            <section class="cv-group cv-group-confirm">
              <h4>{t('paste.groupConfirm', { n: groups.confirm.length })}</h4>
              <ul class="cv-list">{groups.confirm.map((r) => <SlotRow key={r.id} row={r} />)}</ul>
            </section>
          )}
          {groups.candidate.length > 0 && (
            <section class="cv-group cv-group-candidate">
              <h4>{t('paste.groupCandidate', { n: groups.candidate.length })}</h4>
              <ul class="cv-list">{groups.candidate.map((r) => <SlotRow key={r.id} row={r} />)}</ul>
            </section>
          )}
          <details class="cv-group cv-group-auto" open={groups.auto.length <= 3}>
            <summary>
              <h4>{t('paste.groupAuto', { n: groups.auto.length })}</h4>
            </summary>
            <ul class="cv-list">{groups.auto.map((r) => <SlotRow key={r.id} row={r} />)}</ul>
          </details>

          <label class="cv-label">
            {t('paste.note')}
            <input class="cv-input" value={note} onInput={(e) => setNote((e.currentTarget as HTMLInputElement).value)} spellcheck={false} />
          </label>
          <div class="cv-actions">
            <button type="button" class="cv-btn cv-btn-primary" onClick={() => void save()} disabled={busy}>
              {busy ? t('paste.saving') : t('paste.save')}
            </button>
            <button type="button" class="cv-btn" onClick={() => setStep('paste')}>
              {t('common.back')}
            </button>
            <button type="button" class="cv-btn cv-btn-ghost" onClick={props.onCancel}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {rowForForm && (
        <Modal title={t('field.create')} onClose={() => setFieldFormFor(null)}>
          <FieldForm
            scriptId={props.scriptId}
            requireReal={mode === 'editor' || rowForForm.kind === 'unknown'}
            initial={{
              kind: rowForForm.proposal?.kindGuess ?? rowForForm.unknown?.kindGuess ?? 'custom',
              real: mode === 'editor' || rowForForm.kind === 'unknown' ? (blobRaw ?? rowForForm.proposal?.literal ?? rowForForm.unknown?.literal ?? '') : '',
              ...(rowForForm.proposal?.bindingName ? { bindingName: rowForForm.proposal.bindingName } : {}),
              ...(blobRaw !== undefined ? { blobRaw } : {}),
            }}
            onDone={(f) => {
              resolveRow(rowForForm.id, f)
              setFieldFormFor(null)
            }}
            onLink={(f) => {
              resolveRow(rowForForm.id, f)
              setFieldFormFor(null)
            }}
            onCancel={() => setFieldFormFor(null)}
          />
        </Modal>
      )}

      {rowForLink && (
        <Modal title={t('paste.linkField')} onClose={() => setLinkFor(null)}>
          <ul class="cv-list cv-list-compact">
            {session.listFields().map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  class="cv-btn cv-btn-block"
                  onClick={() => {
                    resolveRow(rowForLink.id, f)
                    setLinkFor(null)
                  }}
                >
                  <strong>{f.name}</strong> <span class="cv-muted">{kindLabel(f.kind)} · {f.example}</span>
                </button>
              </li>
            ))}
          </ul>
        </Modal>
      )}

      {duplicateOf !== null && (
        <Modal title={t('paste.identical', { seq: duplicateOf })} onClose={() => setDuplicateOf(null)}>
          <div class="cv-actions">
            <button
              type="button"
              class="cv-btn cv-btn-primary"
              onClick={() => {
                setDuplicateOf(null)
                void save(true)
              }}
            >
              {t('paste.saveAnyway')}
            </button>
            <button type="button" class="cv-btn" onClick={() => setDuplicateOf(null)}>
              {t('common.cancel')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
