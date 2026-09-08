import type { Eol, Field, QuoteKind, Segment, SlotStatus, TemplateContext } from './types'
import { applyEol } from './normalize'

export const SLOT_OPEN = '⟦' // ⟦
export const SLOT_CLOSE = '⟧' // ⟧

const QUOTE_KINDS: readonly QuoteKind[] = ['sq', 'dq', 'hs-sq', 'hs-dq', 'bare', 'comment']

/** Textual serialisation used for export and fixtures: ⟦f:<id>|<quote>[|regex]⟧. Literal ⟦ is doubled. */
export function serializeTemplate(segments: readonly Segment[]): string {
  let out = ''
  for (const seg of segments) {
    if (seg.t === 'text') out += seg.s.split(SLOT_OPEN).join(SLOT_OPEN + SLOT_OPEN)
    else out += `${SLOT_OPEN}f:${seg.fieldId}|${seg.quote}${seg.regex ? '|regex' : ''}${SLOT_CLOSE}`
  }
  return out
}

export function parseTemplate(s: string): Segment[] {
  const segments: Segment[] = []
  let text = ''
  let i = 0
  const flush = () => {
    if (text !== '') {
      segments.push({ t: 'text', s: text })
      text = ''
    }
  }
  while (i < s.length) {
    const c = s[i]!
    if (c === SLOT_OPEN) {
      if (s[i + 1] === SLOT_OPEN) {
        text += SLOT_OPEN
        i += 2
        continue
      }
      if (s.startsWith(SLOT_OPEN + 'f:', i)) {
        const close = s.indexOf(SLOT_CLOSE, i)
        if (close > 0) {
          const body = s.slice(i + 3, close)
          const [fieldId, quote, flag] = body.split('|')
          if (fieldId && quote && (QUOTE_KINDS as readonly string[]).includes(quote)) {
            flush()
            segments.push({
              t: 'slot',
              fieldId,
              quote: quote as QuoteKind,
              conf: 1,
              status: 'auto',
              ...(flag === 'regex' ? { regex: true } : {}),
            })
            i = close + 1
            continue
          }
        }
      }
    }
    text += c
    i++
  }
  flush()
  return segments
}

/** Canonical form for hashing: same as serialisation, which already ignores conf/status. */
export function canonicalize(segments: readonly Segment[]): string {
  return serializeTemplate(segments)
}

export async function contentHash(segments: readonly Segment[]): Promise<string> {
  const data = new TextEncoder().encode(canonicalize(segments))
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function escapeSq(value: string): string {
  return value.replace(/'/g, "''")
}

export function escapeDq(value: string): string {
  return value.replace(/[`"$]/g, (c) => '`' + c)
}

export function escapeHsDq(value: string): string {
  return value.replace(/[`$]/g, (c) => '`' + c)
}

/** Same character set as [regex]::Escape. */
export function regexEscape(value: string): string {
  return value.replace(/[\\*+?|{[()^$.#\s]/g, (c) => '\\' + c)
}

export function needsDqEscaping(value: string): boolean {
  return /[`"$]/.test(value)
}

export function bareNeedsQuoting(value: string): boolean {
  if (value === '') return true
  if (/[\s'"`$;{}()@,|&<>=]/.test(value)) return true
  // Leading characters the lexer would read as a parameter, operator, comment or type literal.
  return /^[-@$+*/%<>=!#:[\]]/.test(value)
}

/** Escape a logical value for a quote context without changing the surrounding literal. */
export function escapeValue(value: string, quote: QuoteKind, opts: { regex?: boolean } = {}): string {
  const v = opts.regex ? regexEscape(value) : value
  switch (quote) {
    case 'sq':
      return escapeSq(v)
    case 'dq':
      return escapeDq(v)
    case 'hs-dq':
      return escapeHsDq(v)
    case 'bare':
      return bareNeedsQuoting(v) ? "'" + escapeSq(v) + "'" : v
    case 'hs-sq':
    case 'comment':
      return v
  }
}

export type RenderMode = 'example' | 'real'

export type RenderIssueKind =
  | 'unknown-field'
  | 'missing-real'
  | 'manual-quote'
  | 'secret-interpolating'
  | 'quote-converted'
  | 'bare-promoted'

export interface RenderIssue {
  kind: RenderIssueKind
  segmentIndex: number
  fieldId?: string
  message: string
}

export interface RenderResult {
  text: string
  issues: RenderIssue[]
}

const LEADING_RUN = /^[^\s;,|(){}'"]+/
const TRAILING_RUN = /[^\s;,|(){}'"=]+$/

/**
 * Render a template with example or real values. Pure: the only inputs are
 * the segments, the field table and (for mode 'real') the decrypted values.
 */
export function render(segments: readonly Segment[], mode: RenderMode, ctx: TemplateContext): RenderResult {
  const pieces: string[] = []
  const issues: RenderIssue[] = []
  let convertNextLeadingQuote = false
  let consumeLeadingRun = false
  let collapseLeadingBackslash = false

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!
    if (seg.t === 'text') {
      let s = seg.s
      if (convertNextLeadingQuote) {
        if (s.startsWith('"')) s = "'" + s.slice(1)
        convertNextLeadingQuote = false
      }
      if (consumeLeadingRun) {
        const m = LEADING_RUN.exec(s)
        if (m) s = s.slice(m[0].length)
        consumeLeadingRun = false
      }
      if (collapseLeadingBackslash) {
        if (s.startsWith('\\') && !s.startsWith('\\\\')) s = s.slice(1)
        collapseLeadingBackslash = false
      }
      pieces.push(s)
      continue
    }

    const field = ctx.fields.get(seg.fieldId)
    if (!field) {
      issues.push({ kind: 'unknown-field', segmentIndex: i, fieldId: seg.fieldId, message: `Unknown field ${seg.fieldId}` })
      pieces.push(`${SLOT_OPEN}?${seg.fieldId}${SLOT_CLOSE}`)
      continue
    }
    let value: string
    if (mode === 'real') {
      const real = ctx.real?.get(seg.fieldId)
      if (real === undefined) {
        issues.push({ kind: 'missing-real', segmentIndex: i, fieldId: field.id, message: `No real value for ${field.name}` })
        value = field.example
      } else {
        value = real
      }
    } else {
      value = field.example
    }
    if (seg.regex) value = regexEscape(value)

    if (ctx.plain) {
      pieces.push(value)
      continue
    }

    const prevIsText = i > 0 && segments[i - 1]!.t === 'text'
    const next = segments[i + 1]
    const nextText = next && next.t === 'text' ? next.s : undefined

    switch (seg.quote) {
      case 'sq':
        pieces.push(escapeSq(value))
        break
      case 'dq': {
        if (!needsDqEscaping(value)) {
          pieces.push(value)
          break
        }
        const last = pieces[pieces.length - 1] ?? ''
        const whole =
          prevIsText && last.endsWith('"') && !last.endsWith('`"') && nextText !== undefined && nextText.startsWith('"')
        if (whole) {
          pieces[pieces.length - 1] = last.slice(0, -1) + "'"
          convertNextLeadingQuote = true
          pieces.push(escapeSq(value))
          issues.push({
            kind: 'quote-converted',
            segmentIndex: i,
            fieldId: field.id,
            message: `Literal for ${field.name} converted to single quotes`,
          })
        } else {
          pieces.push(escapeDq(value))
          if (field.sensitivity === 'secret') {
            issues.push({
              kind: 'secret-interpolating',
              segmentIndex: i,
              fieldId: field.id,
              message: `${field.name} sits inside an interpolating string`,
            })
          }
        }
        break
      }
      case 'hs-sq':
        if (/(^|\n)'@/.test(value)) {
          issues.push({
            kind: 'manual-quote',
            segmentIndex: i,
            fieldId: field.id,
            message: `${field.name} contains a line starting with '@; change the here-string manually`,
          })
        }
        pieces.push(value)
        break
      case 'hs-dq':
        pieces.push(escapeHsDq(value))
        break
      case 'bare': {
        if (!bareNeedsQuoting(value)) {
          pieces.push(value)
          break
        }
        let prefix = ''
        if (prevIsText) {
          const last = pieces[pieces.length - 1]!
          const m = TRAILING_RUN.exec(last)
          if (m) {
            let run = m[0]
            let keep = ''
            const pm = /^(-\w+:)(.*)$/.exec(run)
            if (pm) {
              keep = pm[1]!
              run = pm[2]!
            }
            pieces[pieces.length - 1] = last.slice(0, last.length - m[0].length) + keep
            prefix = run
          }
        }
        let suffix = ''
        if (nextText !== undefined) {
          const m = LEADING_RUN.exec(nextText)
          if (m) {
            suffix = m[0]
            consumeLeadingRun = true
          }
        }
        pieces.push("'" + escapeSq(prefix + value + suffix) + "'")
        issues.push({ kind: 'bare-promoted', segmentIndex: i, fieldId: field.id, message: `${field.name} was quoted` })
        break
      }
      case 'comment':
        pieces.push(value)
        break
    }
    if ((field.kind === 'path' || field.kind === 'unc') && value.endsWith('\\')) collapseLeadingBackslash = true
  }

  let text = pieces.join('')
  if (ctx.eol) text = applyEol(text, ctx.eol)
  return { text, issues }
}

export interface RawSlot {
  start: number
  end: number
  fieldId: string
  quote: QuoteKind
  conf: number
  status: SlotStatus
  regex?: boolean
}

/** Build segments from raw text and non-overlapping raw spans. */
export function spliceSlots(text: string, slots: readonly RawSlot[]): Segment[] {
  const sorted = [...slots].sort((a, b) => a.start - b.start || a.end - b.end)
  const segments: Segment[] = []
  let pos = 0
  for (const slot of sorted) {
    if (slot.start < pos) throw new Error(`Overlapping slots at ${slot.start}`)
    if (slot.end < slot.start || slot.end > text.length) throw new Error(`Slot out of range: ${slot.start}-${slot.end}`)
    if (slot.start > pos) segments.push({ t: 'text', s: text.slice(pos, slot.start) })
    segments.push({
      t: 'slot',
      fieldId: slot.fieldId,
      quote: slot.quote,
      conf: slot.conf,
      status: slot.status,
      ...(slot.regex ? { regex: true } : {}),
    })
    pos = slot.end
  }
  if (pos < text.length) segments.push({ t: 'text', s: text.slice(pos) })
  return segments
}

export function slotSegments(segments: readonly Segment[]): Array<{ index: number; seg: Extract<Segment, { t: 'slot' }> }> {
  const out: Array<{ index: number; seg: Extract<Segment, { t: 'slot' }> }> = []
  segments.forEach((seg, index) => {
    if (seg.t === 'slot') out.push({ index, seg })
  })
  return out
}

export function fieldIdsIn(segments: readonly Segment[]): Set<string> {
  const ids = new Set<string>()
  for (const seg of segments) if (seg.t === 'slot') ids.add(seg.fieldId)
  return ids
}

export function fieldsToMap(fields: Iterable<Field>): Map<string, Field> {
  const m = new Map<string, Field>()
  for (const f of fields) m.set(f.id, f)
  return m
}

export function renderWithEol(segments: readonly Segment[], mode: RenderMode, ctx: TemplateContext, eol: Eol): RenderResult {
  return render(segments, mode, { ...ctx, eol })
}
