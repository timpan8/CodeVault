import { useEffect, useState } from 'preact/hooks'
import type { GuardFinding } from '@engine/guard'
import type { ScriptRecord, VersionRecord } from '@vault/model'
import { getSession, toast, useTick } from '../state'
import { checkRealExport, copyForAi, exportReal, renderForAi } from '../copy'
import { insertSlot, layoutSegments, selectionInfo } from '../layout'
import { useShortcut } from '../keys'
import { FieldForm } from './FieldForm'
import { GuardFindings } from './GuardFindings'
import { Modal } from './Modal'
import { t } from '@i18n/index'

export function Exits(props: { script: ScriptRecord; version: VersionRecord }) {
  useTick()
  const session = getSession()
  const [armed, setArmed] = useState(false)
  const [findings, setFindings] = useState<GuardFinding[] | null>(null)
  const [allowOnce, setAllowOnce] = useState<string[]>([])
  const [bindFinding, setBindFinding] = useState<GuardFinding | null>(null)
  const [busy, setBusy] = useState(false)
  const check = checkRealExport(session, props.version)

  useEffect(() => {
    if (!armed) return
    const id = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(id)
  }, [armed])

  const doCopyForAi = async (extraAllow: string[] = allowOnce) => {
    if (busy) return
    setBusy(true)
    try {
      const text = renderForAi(session, props.script, props.version)
      const res = await copyForAi(session, text, {
        language: props.script.language,
        preamble: session.getSettings().preambleForAi,
        allowOnce: extraAllow,
        scriptId: props.script.id,
      })
      if (res.ok) {
        setFindings(null)
        toast(t('exit.copyForAiDone'), 'ok')
      } else if (res.findings.length > 0) {
        setFindings(res.findings)
        toast(t('exit.copyForAiBlocked', { n: res.findings.length }), 'error')
      } else {
        toast(t('exit.clipboardFailed'), 'error')
      }
    } finally {
      setBusy(false)
    }
  }
  useShortcut('ctrl+shift+c', () => void doCopyForAi())

  const doCopyReal = async () => {
    if (!check.ok) {
      toast(t('exit.copyRealBlocked', { reasons: check.reasons.join('; ') }), 'error', 6000)
      return
    }
    if (!armed) {
      setArmed(true)
      return
    }
    setArmed(false)
    const res = await exportReal(session, props.script, props.version)
    if (res.ok) toast(t('exit.copyRealDone'), 'warn', 6000)
    else toast(res.check.ok ? t('exit.clipboardFailed') : t('exit.copyRealBlocked', { reasons: res.check.reasons.join('; ') }), 'error')
  }

  const bindExisting = async (f: GuardFinding) => {
    // Pass 1: the real value of a known field appears unmarked; mark it.
    if (!f.fieldId) return
    const fields = session.fieldMap()
    const layout = layoutSegments(props.version.segments, fields)
    const info = selectionInfo(layout.text, f.start, f.end, props.script.language)
    try {
      const segments = insertSlot(props.version.segments, fields, f.start, f.end, { fieldId: f.fieldId, quote: info?.quote ?? 'bare', regex: info?.regex ?? false })
      await session.updateVersion(props.version.id, { segments })
      setFindings(null)
      toast(t('script.marked', { name: session.getField(f.fieldId)?.name ?? '' }), 'ok')
    } catch (e) {
      toast(t('common.error', { message: e instanceof Error ? e.message : String(e) }), 'error')
    }
  }

  const onBind = (f: GuardFinding) => {
    if (f.pass === 1 && f.fieldId && f.variant !== 'decoded-base64' && f.variant !== 'domain-suffix') void bindExisting(f)
    else setBindFinding(f)
  }

  const onBindCreated = async (fieldId: string) => {
    const f = bindFinding
    setBindFinding(null)
    if (!f) return
    const fields = session.fieldMap()
    const layout = layoutSegments(props.version.segments, fields)
    const info = selectionInfo(layout.text, f.start, f.end, props.script.language)
    try {
      const segments = insertSlot(props.version.segments, fields, f.start, f.end, { fieldId, quote: info?.quote ?? 'bare', regex: info?.regex ?? false })
      await session.updateVersion(props.version.id, { segments })
      setFindings(null)
      toast(t('script.marked', { name: session.getField(fieldId)?.name ?? '' }), 'ok')
    } catch (e) {
      toast(t('common.error', { message: e instanceof Error ? e.message : String(e) }), 'error')
    }
  }

  return (
    <div class="cv-exits">
      <button type="button" class="cv-btn cv-btn-ai" onClick={() => void doCopyForAi()} disabled={busy} title="Ctrl+Shift+C">
        🛡 {findings ? t('exit.copyForAiFindings', { n: findings.length }) : t('exit.copyForAi')}
      </button>
      <div class="cv-real-wrap">
        <button
          type="button"
          class={`cv-btn cv-btn-real ${armed ? 'cv-btn-real-armed' : ''} ${check.ok ? '' : 'cv-btn-disabled'}`}
          onClick={() => void doCopyReal()}
          aria-disabled={!check.ok}
        >
          🔒 {armed ? t('exit.copyRealArmed') : t('exit.copyReal')}
        </button>
        {(armed || !check.ok) && (
          <ul class="cv-checklist">
            <li class={check.missingValues.length ? 'cv-bad' : 'cv-ok'}>{t('exit.check.fields', { done: check.fieldsResolved, total: check.fieldsTotal })}</li>
            {check.unresolvedSecret > 0 && <li class="cv-bad">{t('exit.check.unresolvedSecret', { n: check.unresolvedSecret })}</li>}
            {check.missingValues.length > 0 && <li class="cv-bad">{t('exit.check.missingValue', { names: check.missingValues.join(', ') })}</li>}
            {props.version.needsReview && <li class="cv-bad">{t('exit.check.needsReview')}</li>}
            {check.secretsInOutput > 0 && <li class="cv-warn">{t('exit.check.secretsInOutput', { n: check.secretsInOutput })}</li>}
            {check.interpolating > 0 && <li class="cv-warn">{t('exit.check.interpolating', { n: check.interpolating })}</li>}
            {check.unknownMarkers > 0 && <li class="cv-bad">{t('exit.check.unknownMarkers')}</li>}
          </ul>
        )}
      </div>
      {findings && (
        <GuardFindings
          findings={findings}
          onBind={onBind}
          onAllowOnce={(f) => {
            const next = [...allowOnce, f.matched]
            setAllowOnce(next)
            void doCopyForAi(next)
          }}
          onAllowAlways={(f) => {
            void session.addAllowlist(f.matched).then(() => doCopyForAi())
          }}
          onClose={() => setFindings(null)}
        />
      )}
      {bindFinding && (
        <Modal title={t('exit.guardBind')} onClose={() => setBindFinding(null)}>
          <FieldForm
            scriptId={props.script.id}
            requireReal
            initial={{ ...(bindFinding.kind ? { kind: bindFinding.kind } : {}), real: bindFinding.matched }}
            onDone={(f) => void onBindCreated(f.id)}
            onLink={(f) => void onBindCreated(f.id)}
            onCancel={() => setBindFinding(null)}
          />
        </Modal>
      )}
    </div>
  )
}
