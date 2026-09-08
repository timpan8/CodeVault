import { useState } from 'preact/hooks'
import { guard, type GuardFinding } from '@engine/guard'
import { applyProposals } from '@engine/reapply'
import { render } from '@engine/template'
import { engine, getSession, toast } from '../state'
import { copyForAi } from '../copy'
import { FieldForm } from '../components/FieldForm'
import { GuardFindings } from '../components/GuardFindings'
import { Modal } from '../components/Modal'
import { t } from '@i18n/index'

/**
 * Scratch pane: paste anything (error messages, transcripts, Get-ADUser
 * output), known real values are replaced by examples, the rest is scanned.
 * Nothing is saved.
 */
export function Sanitize() {
  const session = getSession()
  const [raw, setRaw] = useState('')
  const [out, setOut] = useState<string | null>(null)
  const [replaced, setReplaced] = useState(0)
  const [findings, setFindings] = useState<GuardFinding[]>([])
  const [showFindings, setShowFindings] = useState(false)
  const [bind, setBind] = useState<GuardFinding | null>(null)
  const [allowOnce, setAllowOnce] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const run = async (extraAllow: string[] = allowOnce) => {
    if (!raw.trim()) return
    setBusy(true)
    try {
      const snap = session.snapshot()
      const n = await engine.normalizePaste(raw)
      const text = n.blocks.map((b) => b.text).join('\n') + (n.prose ? '\n' + n.prose : '')
      const res = await engine.reapply({ text, language: 'plain', fields: snap.all, real: [...snap.real], retired: snap.retired, mode: 'editor', ns: snap.ns })
      const accepted = res.slots.filter((s) => s.fieldId !== null && s.status !== 'candidate')
      const segments = applyProposals(text, accepted)
      const rendered = render(segments, 'example', { fields: session.fieldMap(), plain: true }).text
      setReplaced(accepted.length)
      setOut(rendered)
      const g = guard({
        text: rendered,
        fields: snap.all,
        real: snap.real,
        retired: snap.retired,
        allowlist: [...snap.allowlist, ...extraAllow.map((value) => ({ value }))],
        ns: snap.ns,
        ...(snap.orgHostRegex ? { orgHostRegex: snap.orgHostRegex } : {}),
        language: 'plain',
      })
      setFindings(g.findings)
      setShowFindings(g.findings.length > 0)
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (out === null) return
    const res = await copyForAi(session, out, { language: 'plain', preamble: false, allowOnce })
    if (res.ok) toast(t('exit.copyForAiDone'), 'ok')
    else if (res.findings.length) {
      setFindings(res.findings)
      setShowFindings(true)
    } else toast(t('exit.clipboardFailed'), 'error')
  }

  return (
    <div class="cv-page">
      <h2>{t('sanitize.title')}</h2>
      <p class="cv-muted">{t('sanitize.intro')}</p>
      <textarea class="cv-textarea" value={raw} onInput={(e) => setRaw((e.currentTarget as HTMLTextAreaElement).value)} spellcheck={false} autocomplete="off" rows={12} />
      <div class="cv-actions">
        <button type="button" class="cv-btn cv-btn-primary" onClick={() => void run()} disabled={busy}>
          {t('sanitize.run')}
        </button>
      </div>
      {out !== null && (
        <section class="cv-card cv-card-wide">
          <h3>{t('sanitize.result')}</h3>
          <p class="cv-muted">
            {t('sanitize.replaced', { n: replaced })} {findings.length > 0 ? <span class="cv-bad">{t('sanitize.findings', { n: findings.length })}</span> : <span class="cv-ok">{t('sanitize.clean')}</span>}
          </p>
          <pre class="cv-pre cv-pre-scroll" onContextMenu={(e) => e.preventDefault()}>
            {out}
          </pre>
          <div class="cv-actions">
            <button type="button" class="cv-btn cv-btn-ai" onClick={() => void copy()} disabled={findings.length > 0}>
              🛡 {findings.length ? t('exit.copyForAiFindings', { n: findings.length }) : t('exit.copyForAi')}
            </button>
            {findings.length > 0 && (
              <button type="button" class="cv-btn" onClick={() => setShowFindings(true)}>
                {t('exit.guardTitle')}
              </button>
            )}
          </div>
        </section>
      )}
      {showFindings && (
        <GuardFindings
          findings={findings}
          onBind={(f) => {
            setShowFindings(false)
            setBind(f)
          }}
          onAllowOnce={(f) => {
            const next = [...allowOnce, f.matched]
            setAllowOnce(next)
            setShowFindings(false)
            void run(next)
          }}
          onAllowAlways={(f) => {
            setShowFindings(false)
            void session.addAllowlist(f.matched).then(() => run())
          }}
          onClose={() => setShowFindings(false)}
        />
      )}
      {bind && (
        <Modal title={t('exit.guardBind')} onClose={() => setBind(null)}>
          <FieldForm
            requireReal
            initial={{ ...(bind.kind ? { kind: bind.kind } : {}), real: bind.matched }}
            onDone={() => {
              setBind(null)
              void run()
            }}
            onLink={() => {
              setBind(null)
              void run()
            }}
            onCancel={() => setBind(null)}
          />
        </Modal>
      )}
    </div>
  )
}
