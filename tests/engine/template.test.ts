import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { lex, rawSpanForLogicalRange } from '@engine/lexer/powershell'
import {
  contentHash,
  escapeValue,
  parseTemplate,
  render,
  serializeTemplate,
  spliceSlots,
  type RawSlot,
} from '@engine/template'
import { createField } from '@engine/fields'
import type { Field, QuoteKind, Segment } from '@engine/types'

const NOW = '2026-01-01T00:00:00.000Z'
const mkField = (id: string, kind: Field['kind'], example: string, extra: Partial<Field> = {}): Field => ({
  ...createField({ id, name: id.toUpperCase(), kind, example, now: NOW }),
  ...extra,
})

const fields = new Map<string, Field>([
  ['user', mkField('user', 'username', 'svc-example01')],
  ['pw', mkField('pw', 'password', 'Ex@mple-Passw0rd-1')],
  ['srv', mkField('srv', 'server', 'SRV-EXAMPLE01.corp.example')],
  ['root', mkField('root', 'path', 'C:\\Example\\Project01')],
])

/** Mark whole literals whose logical value equals the field example. */
function markWholeLiterals(text: string, byExample: Record<string, string>): Segment[] {
  const slots: RawSlot[] = []
  for (const tok of lex(text)) {
    if (tok.kind !== 'string' && tok.kind !== 'bareword') continue
    const fieldId = byExample[tok.logical ?? '']
    if (!fieldId) continue
    slots.push({ start: tok.contentStart!, end: tok.contentEnd!, fieldId, quote: tok.quote!, conf: 1, status: 'auto' })
  }
  return spliceSlots(text, slots)
}

describe('serialize/parse', () => {
  it('round-trips segments and escapes literal ⟦', () => {
    const segs: Segment[] = [
      { t: 'text', s: 'a ⟦ b "' },
      { t: 'slot', fieldId: 'pw', quote: 'dq', conf: 1, status: 'auto' },
      { t: 'text', s: '" -match \'' },
      { t: 'slot', fieldId: 'srv', quote: 'sq', conf: 1, status: 'auto', regex: true },
      { t: 'text', s: "'" },
    ]
    const s = serializeTemplate(segs)
    expect(s).toBe('a ⟦⟦ b "⟦f:pw|dq⟧" -match \'⟦f:srv|sq|regex⟧\'')
    expect(parseTemplate(s)).toEqual(segs)
  })

  it('hashes canonical form', async () => {
    const a = await contentHash([{ t: 'text', s: 'x' }])
    const b = await contentHash([{ t: 'text', s: 'x' }])
    const c = await contentHash([{ t: 'text', s: 'y' }])
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('render', () => {
  const script = [
    "$User = 'svc-example01'",
    '$Pw = "Ex@mple-Passw0rd-1"',
    "Connect-Thing -Server SRV-EXAMPLE01.corp.example -Path 'C:\\Example\\Project01\\out.csv'",
    '# note: svc-example01',
  ].join('\n')
  const byExample = {
    'svc-example01': 'user',
    'Ex@mple-Passw0rd-1': 'pw',
    'SRV-EXAMPLE01.corp.example': 'srv',
  }

  it('example rendering reproduces the paste exactly', () => {
    const segs = markWholeLiterals(script, byExample)
    expect(segs.filter((s) => s.t === 'slot')).toHaveLength(3)
    const out = render(segs, 'example', { fields })
    expect(out.text).toBe(script)
    expect(out.issues).toEqual([])
  })

  it('real rendering escapes per quote context', () => {
    const segs = markWholeLiterals(script, byExample)
    const real = new Map([
      ['user', "o'brien"],
      ['pw', 'Pa$$w0rd"x'],
      ['srv', 'dc01.corp.contoso.se'],
    ])
    const out = render(segs, 'real', { fields, real })
    expect(out.text).toContain("$User = 'o''brien'")
    // whole double-quoted literal converted to single quotes
    expect(out.text).toContain("$Pw = 'Pa$$w0rd\"x'")
    expect(out.text).toContain('-Server dc01.corp.contoso.se ')
    expect(out.issues.map((i) => i.kind)).toEqual(['quote-converted'])
  })

  it('substring slot in an interpolating string is backtick-escaped and flagged', () => {
    const text = '$s = "Server=$srv;Password=Ex@mple-Passw0rd-1;"'
    const tok = lex(text).find((t) => t.kind === 'string')!
    const idx = tok.logical!.indexOf('Ex@mple-Passw0rd-1')
    const span = rawSpanForLogicalRange(tok, idx, idx + 'Ex@mple-Passw0rd-1'.length, text)
    const segs = spliceSlots(text, [{ ...span, fieldId: 'pw', quote: 'dq', conf: 1, status: 'auto' }])
    const out = render(segs, 'real', { fields, real: new Map([['pw', 'a$b`c"d']]) })
    expect(out.text).toBe('$s = "Server=$srv;Password=a`$b``c`"d;"')
    expect(out.issues.map((i) => i.kind)).toEqual(['secret-interpolating'])
    expect(render(segs, 'example', { fields }).text).toBe(text)
  })

  it('bare value with spaces is promoted to a quoted literal including neighbours', () => {
    const text = 'Export-Csv -Path C:\\Example\\Project01\\out.csv -NoTypeInformation'
    const start = text.indexOf('C:\\Example\\Project01')
    const segs = spliceSlots(text, [
      { start, end: start + 'C:\\Example\\Project01'.length, fieldId: 'root', quote: 'bare', conf: 1, status: 'auto' },
    ])
    const out = render(segs, 'real', { fields, real: new Map([['root', 'C:\\My Data\\Proj']]) })
    expect(out.text).toBe("Export-Csv -Path 'C:\\My Data\\Proj\\out.csv' -NoTypeInformation")
    expect(out.issues.map((i) => i.kind)).toEqual(['bare-promoted'])
  })

  it('bare value with -Param: prefix keeps the parameter outside the quotes', () => {
    const text = 'Export-Csv -Path:C:\\Example\\Project01\\out.csv'
    const start = text.indexOf('C:\\Example\\Project01')
    const segs = spliceSlots(text, [
      { start, end: start + 'C:\\Example\\Project01'.length, fieldId: 'root', quote: 'bare', conf: 1, status: 'auto' },
    ])
    const out = render(segs, 'real', { fields, real: new Map([['root', 'C:\\My Data']]) })
    expect(out.text).toBe("Export-Csv -Path:'C:\\My Data\\out.csv'")
  })

  it('path with trailing backslash does not double the separator', () => {
    const text = "Out-File 'C:\\Example\\Project01\\log.txt'"
    const start = text.indexOf('C:\\Example\\Project01')
    const segs = spliceSlots(text, [
      { start, end: start + 'C:\\Example\\Project01'.length, fieldId: 'root', quote: 'sq', conf: 1, status: 'auto' },
    ])
    const out = render(segs, 'real', { fields, real: new Map([['root', 'D:\\Out\\']]) })
    expect(out.text).toBe("Out-File 'D:\\Out\\log.txt'")
  })

  it('here-string single-quoted flags a value with a line starting with \'@', () => {
    const text = "$x = @'\nEx@mple-Passw0rd-1\n'@"
    const segs = markWholeLiterals(text, { 'Ex@mple-Passw0rd-1': 'pw' })
    const out = render(segs, 'real', { fields, real: new Map([['pw', "a\n'@b"]]) })
    expect(out.issues.map((i) => i.kind)).toEqual(['manual-quote'])
  })

  it('missing real value falls back to example and reports', () => {
    const segs = markWholeLiterals("$User = 'svc-example01'", { 'svc-example01': 'user' })
    const out = render(segs, 'real', { fields, real: new Map() })
    expect(out.text).toBe("$User = 'svc-example01'")
    expect(out.issues.map((i) => i.kind)).toEqual(['missing-real'])
  })

  it('unknown field emits a visible marker', () => {
    const out = render([{ t: 'slot', fieldId: 'nope', quote: 'sq', conf: 1, status: 'auto' }], 'example', { fields })
    expect(out.text).toContain('⟦?nope⟧')
    expect(out.issues[0]!.kind).toBe('unknown-field')
  })

  it('regex slot escapes metacharacters before quoting', () => {
    const text = "$x -match 'SRV-EXAMPLE01.corp.example'"
    const tok = lex(text).find((t) => t.kind === 'string')!
    const segs = spliceSlots(text, [
      { start: tok.contentStart!, end: tok.contentEnd!, fieldId: 'srv', quote: 'sq', conf: 1, status: 'auto', regex: true },
    ])
    const out = render(segs, 'real', { fields, real: new Map([['srv', 'dc01.corp.local']]) })
    expect(out.text).toBe("$x -match 'dc01\\.corp\\.local'")
  })

  it('applies CRLF when requested', () => {
    const out = render([{ t: 'text', s: 'a\nb' }], 'example', { fields, eol: 'crlf' })
    expect(out.text).toBe('a\r\nb')
  })
})

describe('escape round-trip property: parse(render(v, q)) == v', () => {
  const valueArb = fc
    .string({ unit: fc.constantFrom(...'abcXYZ019 $`\'"\\-_.@:;{}()[]|&<>#!?*+^%~=åäöÅÄÖ'.split('')), minLength: 1, maxLength: 24 })
    .filter((v) => v.trim() !== '')

  const wrap = (v: string, q: QuoteKind): string => {
    switch (q) {
      case 'sq':
        return `$x = '${escapeValue(v, 'sq')}'`
      case 'dq':
        return `$x = "${escapeValue(v, 'dq')}"`
      case 'hs-sq':
        return `$x = @'\n${v}\n'@`
      case 'hs-dq':
        return `$x = @"\n${escapeValue(v, 'hs-dq')}\n"@`
      case 'bare':
        return `Do-It -Name ${escapeValue(v, 'bare')}`
      case 'comment':
        return `# ${v}`
    }
  }

  for (const q of ['sq', 'dq', 'hs-sq', 'hs-dq', 'bare'] as const) {
    it(`quote kind ${q}`, () => {
      fc.assert(
        fc.property(valueArb, (v) => {
          const text = wrap(v, q)
          const tok = lex(text).find((t) => t.kind === 'string' || t.kind === 'number' || (t.kind === 'bareword' && t.raw !== 'Do-It'))
          expect(tok, text).toBeDefined()
          expect(tok!.logical).toBe(v)
        }),
        { numRuns: 400 },
      )
    })
  }

  it('render(real) through the template layer parses back to the real value', () => {
    const f = new Map<string, Field>([['v', mkField('v', 'custom', 'EXAMPLE-VALUE-01')]])
    fc.assert(
      fc.property(valueArb, fc.constantFrom<QuoteKind>('sq', 'dq', 'hs-dq', 'bare'), (v, q) => {
        const example = 'EXAMPLE-VALUE-01'
        const text = wrap(example, q)
        const tok = lex(text).find((t) => t.logical === example)!
        const segs = spliceSlots(text, [
          { start: tok.contentStart!, end: tok.contentEnd!, fieldId: 'v', quote: q, conf: 1, status: 'auto' },
        ])
        const out = render(segs, 'real', { fields: f, real: new Map([['v', v]]) })
        const back = lex(out.text).find((t) => (t.kind === 'string' || t.kind === 'bareword' || t.kind === 'number') && t.raw !== 'Do-It')
        expect(back, out.text).toBeDefined()
        expect(back!.logical, out.text).toBe(v)
      }),
      { numRuns: 400 },
    )
  })
})
