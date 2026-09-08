/**
 * Pure helpers between the template model and the read-only editor. The
 * editor document IS the example rendering, so document offsets equal the
 * offsets computed here; every slot maps to one pill.
 */
import { lex, unescapeDq, unescapeHsDq, unescapeSq, type Token } from '@engine/lexer/powershell'
import { escapeValue, SLOT_CLOSE, SLOT_OPEN } from '@engine/template'
import type { Field, QuoteKind, Segment, SlotStatus } from '@engine/types'

export interface SlotLayout {
  from: number
  to: number
  fieldId: string
  segmentIndex: number
  quote: QuoteKind
  status: SlotStatus
  regex: boolean
  missingField: boolean
}

export interface Layout {
  text: string
  slots: SlotLayout[]
}

/** Rendered text of one slot in example mode (mirrors render()). */
export function slotText(seg: Extract<Segment, { t: 'slot' }>, field: Field | undefined): string {
  if (!field) return `${SLOT_OPEN}?${seg.fieldId}${SLOT_CLOSE}`
  return escapeValue(field.example, seg.quote, { regex: seg.regex === true })
}

export function layoutSegments(segments: readonly Segment[], fields: ReadonlyMap<string, Field>): Layout {
  let text = ''
  const slots: SlotLayout[] = []
  segments.forEach((seg, segmentIndex) => {
    if (seg.t === 'text') {
      text += seg.s
      return
    }
    const field = fields.get(seg.fieldId)
    const piece = slotText(seg, field)
    slots.push({
      from: text.length,
      to: text.length + piece.length,
      fieldId: seg.fieldId,
      segmentIndex,
      quote: seg.quote,
      status: seg.status,
      regex: seg.regex === true,
      missingField: field === undefined,
    })
    text += piece
  })
  return { text, slots }
}

export interface SelectionInfo {
  from: number
  to: number
  raw: string
  logical: string
  quote: QuoteKind
  wholeLiteral: boolean
  regex: boolean
  bindingName?: string
  token?: Token
}

function unescapeFor(raw: string, quote: QuoteKind): string {
  switch (quote) {
    case 'sq':
      return unescapeSq(raw)
    case 'dq':
      return unescapeDq(raw)
    case 'hs-dq':
      return unescapeHsDq(raw)
    default:
      return raw
  }
}

/**
 * Describe a selection in the rendered text: snap to the containing token's
 * content when the selection is empty or covers the quotes, derive the
 * quote context and the logical (unescaped) value.
 */
export function selectionInfo(text: string, from: number, to: number, language: 'powershell' | 'plain' = 'powershell'): SelectionInfo | undefined {
  if (from > to) [from, to] = [to, from]
  const tokens = language === 'plain' ? lex(text) : lex(text)
  const probe = from === to ? from : from
  const tok = tokens.find((t) => t.start <= probe && probe < t.end && (t.kind === 'string' || t.kind === 'bareword' || t.kind === 'number' || t.kind === 'comment'))
  if (!tok) {
    if (from === to) return undefined
    const raw = text.slice(from, to)
    if (raw.trim() === '') return undefined
    return { from, to, raw, logical: raw, quote: 'bare', wholeLiteral: false, regex: false }
  }
  const cs = tok.contentStart ?? tok.start
  const ce = tok.contentEnd ?? tok.end
  let f = from
  let t = to
  if (from === to) {
    f = cs
    t = ce
  } else {
    // snap a selection that includes the quote characters to the content
    if (f < cs) f = cs
    if (t > ce) t = ce
  }
  if (t <= f) return undefined
  const raw = text.slice(f, t)
  const quote: QuoteKind = tok.quote ?? 'bare'
  return {
    from: f,
    to: t,
    raw,
    logical: unescapeFor(raw, quote),
    quote,
    wholeLiteral: f === cs && t === ce,
    regex: tok.regexContext === true,
    ...(tok.binding ? { bindingName: tok.binding.name } : {}),
    token: tok,
  }
}

/** Split the text segment that contains [from, to) and insert a slot. Throws if the range crosses a slot. */
export function insertSlot(
  segments: readonly Segment[],
  fields: ReadonlyMap<string, Field>,
  from: number,
  to: number,
  slot: { fieldId: string; quote: QuoteKind; regex?: boolean; conf?: number; status?: SlotStatus },
): Segment[] {
  const out: Segment[] = []
  let offset = 0
  let inserted = false
  for (const seg of segments) {
    if (seg.t === 'slot') {
      const len = slotText(seg, fields.get(seg.fieldId)).length
      if (from < offset + len && offset < to) throw new Error('Selection overlaps an existing field')
      out.push(seg)
      offset += len
      continue
    }
    const segEnd = offset + seg.s.length
    if (!inserted && from >= offset && to <= segEnd) {
      const before = seg.s.slice(0, from - offset)
      const after = seg.s.slice(to - offset)
      if (before) out.push({ t: 'text', s: before })
      out.push({
        t: 'slot',
        fieldId: slot.fieldId,
        quote: slot.quote,
        conf: slot.conf ?? 1,
        status: slot.status ?? 'auto',
        ...(slot.regex ? { regex: true } : {}),
      })
      if (after) out.push({ t: 'text', s: after })
      inserted = true
    } else {
      out.push(seg)
    }
    offset = segEnd
  }
  if (!inserted) throw new Error('Selection is not inside a single text segment')
  return out
}

/** Turn one slot back into plain text (the example text stays as the AI wrote it). */
export function removeSlot(segments: readonly Segment[], fields: ReadonlyMap<string, Field>, segmentIndex: number): Segment[] {
  const out: Segment[] = []
  segments.forEach((seg, i) => {
    if (i === segmentIndex && seg.t === 'slot') {
      const text = slotText(seg, fields.get(seg.fieldId))
      const last = out[out.length - 1]
      if (last && last.t === 'text') last.s += text
      else out.push({ t: 'text', s: text })
      return
    }
    const last = out[out.length - 1]
    if (seg.t === 'text' && last && last.t === 'text') last.s += seg.s
    else out.push(seg.t === 'text' ? { t: 'text', s: seg.s } : { ...seg })
  })
  return out
}

/** Set the status of one slot (e.g. confirm -> auto after the user accepted it). */
export function setSlotStatus(segments: readonly Segment[], segmentIndex: number, status: SlotStatus): Segment[] {
  return segments.map((seg, i) => (i === segmentIndex && seg.t === 'slot' ? { ...seg, status } : seg))
}

export function unresolvedSecretSlots(segments: readonly Segment[], fields: ReadonlyMap<string, Field>): number {
  let n = 0
  for (const seg of segments) {
    if (seg.t !== 'slot') continue
    const f = fields.get(seg.fieldId)
    if (seg.status === 'confirm' && f && (f.kind === 'password' || f.kind === 'apiKey' || f.kind === 'blob')) n++
  }
  return n
}
