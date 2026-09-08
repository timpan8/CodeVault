/**
 * The two exits.
 *
 * exportReal() is the ONLY code path in the application that renders real
 * values into text that leaves the tool. Every "copy real" control must call
 * it; nothing else may call render(..., 'real') for the clipboard.
 *
 * copyForAi() always runs the leak guard first and refuses on any finding.
 */
import { render } from '@engine/template'
import { guard, type GuardFinding } from '@engine/guard'
import { SENTINEL_PREAMBLE, SENTINEL_REAL } from '@engine/sentinels'
import type { VaultSession } from '@vault/session'
import type { ScriptRecord, VersionRecord } from '@vault/model'
import { unresolvedSecretSlots } from './layout'
import { writeClipboard } from './clipboard'
import { t } from '@i18n/index'

export interface RealCheck {
  ok: boolean
  reasons: string[]
  fieldsTotal: number
  fieldsResolved: number
  unresolvedSecret: number
  missingValues: string[]
  secretsInOutput: number
  interpolating: number
  unknownMarkers: number
}

/** Pre-copy checklist. Pure apart from reading the session. */
export function checkRealExport(session: VaultSession, version: VersionRecord): RealCheck {
  const fields = session.fieldMap()
  const real = session.snapshot().real
  const ids = new Set<string>()
  let unknownMarkers = 0
  for (const seg of version.segments) {
    if (seg.t !== 'slot') continue
    ids.add(seg.fieldId)
    if (!fields.has(seg.fieldId)) unknownMarkers++
  }
  const missingValues: string[] = []
  for (const id of ids) {
    const f = fields.get(id)
    if (f && real.get(id) === undefined) missingValues.push(f.name)
  }
  const unresolvedSecret = unresolvedSecretSlots(version.segments, fields)
  const preview = render(version.segments, 'real', { fields, real })
  const secretsInOutput = version.reviewLog.filter((e) => e.method.includes('secret-in-output')).length
  const interpolating = preview.issues.filter((i) => i.kind === 'secret-interpolating').length
  const reasons: string[] = []
  if (version.needsReview) reasons.push(t('exit.check.needsReview'))
  if (unresolvedSecret > 0) reasons.push(t('exit.check.unresolvedSecret', { n: unresolvedSecret }))
  if (missingValues.length > 0) reasons.push(t('exit.check.missingValue', { names: missingValues.join(', ') }))
  if (unknownMarkers > 0) reasons.push(t('exit.check.unknownMarkers'))
  return {
    ok: reasons.length === 0,
    reasons,
    fieldsTotal: ids.size,
    fieldsResolved: ids.size - missingValues.length - unknownMarkers,
    unresolvedSecret,
    missingValues,
    secretsInOutput,
    interpolating,
    unknownMarkers,
  }
}

/** The only place real text is handed to the clipboard (banner, countdown, honest clearing). */
async function writeRealToClipboard(text: string): Promise<boolean> {
  return writeClipboard(text, 'real')
}

/** THE single real-value exit for versions. Returns false when the checklist blocks or the clipboard write fails. */
export async function exportReal(session: VaultSession, script: ScriptRecord, version: VersionRecord): Promise<{ ok: boolean; check: RealCheck }> {
  const check = checkRealExport(session, version)
  if (!check.ok) return { ok: false, check }
  const fields = session.fieldMap()
  const real = session.snapshot().real
  const rendered = render(version.segments, 'real', { fields, real, plain: script.language === 'plain' })
  const eolText = script.eol === 'crlf' ? '\r\n' : '\n'
  const body = rendered.text.replace(/\r\n?|\n/g, eolText)
  const prefix = script.language === 'powershell' ? SENTINEL_REAL + eolText : ''
  const ok = await writeRealToClipboard(prefix + body)
  if (ok) await session.updateScript(script.id, { lastCopiedRealAt: new Date().toISOString() })
  return { ok, check }
}

/** One-liner that creates a project folder; carries a real path, so it goes through the real exit. */
export async function copyNewItemLine(path: string): Promise<boolean> {
  const line = `New-Item -ItemType Directory -Path '${path.replace(/'/g, "''")}' -Force | Out-Null`
  return writeRealToClipboard(line)
}

export interface AiCopyResult {
  ok: boolean
  findings: GuardFinding[]
  text: string
}

export interface AiCopyOptions {
  language?: 'powershell' | 'plain'
  preamble?: boolean
  /** Findings the user allowed for this copy only (pass 2). */
  allowOnce?: string[]
  scriptId?: string
}

/** Run the guard on sanitized text and copy it only when nothing is found. */
export async function copyForAi(session: VaultSession, text: string, opts: AiCopyOptions = {}): Promise<AiCopyResult> {
  const snap = session.snapshot()
  const result = guard({
    text,
    fields: snap.all,
    real: snap.real,
    retired: snap.retired,
    allowlist: [...snap.allowlist, ...(opts.allowOnce ?? []).map((value) => ({ value }))],
    ns: snap.ns,
    ...(snap.orgHostRegex ? { orgHostRegex: snap.orgHostRegex } : {}),
    language: opts.language ?? 'powershell',
  })
  if (result.blocked) return { ok: false, findings: result.findings, text }
  const preamble = opts.preamble && (opts.language ?? 'powershell') === 'powershell' ? SENTINEL_PREAMBLE + '\n' : ''
  const ok = await writeClipboard(preamble + text, 'ai')
  if (ok && opts.scriptId) await session.updateScript(opts.scriptId, { lastCopiedForAiAt: new Date().toISOString() })
  return { ok, findings: [], text }
}

/** Sanitized rendering of a version (LF; chats do not care about line endings). */
export function renderForAi(session: VaultSession, script: ScriptRecord, version: VersionRecord): string {
  return render(version.segments, 'example', { fields: session.fieldMap(), plain: script.language === 'plain' }).text
}
