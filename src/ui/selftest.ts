/**
 * In-app self-test: a compact version of the engine invariants that the
 * Vitest corpus checks, runnable in the browser from the About page.
 */
import { lex } from '@engine/lexer/powershell'
import { escapeValue, parseTemplate, render, spliceSlots } from '@engine/template'
import { createField } from '@engine/fields'
import { reapply } from '@engine/reapply'
import { guard } from '@engine/guard'
import { base64Utf16le } from '@engine/encoding'
import type { Field, QuoteKind } from '@engine/types'

export interface SelfTestResult {
  total: number
  failed: string[]
}

const NOW = '2026-01-01T00:00:00.000Z'

export async function runSelfTest(): Promise<SelfTestResult> {
  const failed: string[] = []
  let total = 0
  const check = (name: string, ok: boolean) => {
    total++
    if (!ok) failed.push(name)
  }

  const user = createField({ id: 'u', name: 'USER', kind: 'username', example: 'svc-example01', now: NOW })
  const pw = createField({ id: 'p', name: 'PW', kind: 'password', example: 'Ex@mple-Passw0rd-1', now: NOW })
  const fields = new Map<string, Field>([
    [user.id, user],
    [pw.id, pw],
  ])
  const real = new Map([
    ['u', 'svc-adsync'],
    ['p', 'Pa$$w0rd"x'],
  ])

  // escaping round trip per quote kind
  const values = ["it's", 'a$b`c"d', 'plain', 'with space', 'åäö-ok']
  for (const q of ['sq', 'dq', 'hs-dq', 'bare'] as QuoteKind[]) {
    for (const v of values) {
      const wrapped =
        q === 'sq' ? `$x = '${escapeValue(v, 'sq')}'` : q === 'dq' ? `$x = "${escapeValue(v, 'dq')}"` : q === 'hs-dq' ? `$x = @"\n${escapeValue(v, 'hs-dq')}\n"@` : `Do-It -Name ${escapeValue(v, 'bare')}`
      const tok = lex(wrapped).find((t) => (t.kind === 'string' || t.kind === 'bareword') && t.raw !== 'Do-It')
      check(`escape ${q} ${JSON.stringify(v)}`, tok?.logical === v)
    }
  }

  // re-apply on the canonical example, render both ways
  const paste = "$Username = 'svc-example01'\n$Password = 'Ex@mple-Passw0rd-1'"
  const res = reapply({ text: paste, fields: [user, pw], real, mode: 'ai' })
  check('reapply finds both examples as auto', res.slots.length === 2 && res.slots.every((s) => s.status === 'auto'))
  const segs = spliceSlots(
    paste,
    res.slots.map((s) => ({ start: s.start, end: s.end, fieldId: s.fieldId!, quote: s.quote, conf: s.conf, status: 'auto' as const })),
  )
  check('example rendering reproduces the paste', render(segs, 'example', { fields }).text === paste)
  const realText = render(segs, 'real', { fields, real }).text
  check('real rendering converts to single quotes', realText.includes(`'Pa$$w0rd"x'`))
  check('guard finds real values in the real rendering', guard({ text: realText, fields: [user, pw], real }).findings.some((f) => f.pass === 1))
  check('guard is silent on the example rendering', !guard({ text: paste, fields: [user, pw], real }).blocked)

  // editor mode extracts real values
  const editor = reapply({ text: "$Username = 'svc-adsync'\nConnect -Server 'dc02.corp.contoso.se'", fields: [user, pw], real, mode: 'editor' })
  check('editor mode extracts the real value', editor.slots.some((s) => s.fieldId === 'u' && s.status === 'auto'))
  check('editor mode flags the unknown server', editor.unknown.length === 1)

  // encoded command
  const enc = base64Utf16le("$p = 'Pa$$w0rd\"x'")
  check('guard decodes base64 utf-16le', guard({ text: `powershell -EncodedCommand ${enc}`, fields: [user, pw], real }).findings.some((f) => f.variant === 'decoded-base64'))

  // template round trip
  const tmpl = parseTemplate("$u = '⟦f:u|sq⟧'")
  check('template parse/render', render(tmpl, 'example', { fields }).text === "$u = 'svc-example01'")

  // short value is never matched by value
  const short = new Map([['u', 'tp']])
  check('short values are not scanned by value', !guard({ text: 'Stop-Process tp', fields: [user], real: short }).blocked)

  return { total, failed }
}
