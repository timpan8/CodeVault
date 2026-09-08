/**
 * Re-apply engine: given a new paste, the previous version and the field
 * table, propose slots with a confidence and a status. Only exact hits on a
 * field's example (or an unchanged/moved line) become 'auto'; everything
 * else is 'confirm' or 'candidate' and needs a human.
 */
import { lex, lexPlain, rawSpanForLogicalRange, valueTokens, type Token } from './lexer/powershell'
import { ALIAS_STOPLIST, matchRuleFor, normalizeAnchorName, validateExample, type MatchRule } from './fields'
import { render, spliceSlots, type RawSlot } from './template'
import {
  detectCandidates,
  detectTableBlocks,
  isDestructiveContext,
  isOutputContext,
  kindCompatible,
  kindFromBindingName,
  type DetectorOptions,
} from './detectors'
import { DEFAULT_NAMESPACE, isInExampleNamespace, type ExampleNamespace } from './examples'
import { base64Runs, decodeBase64Variants, shannonEntropy } from './encoding'
import type { Field, FieldAlias, FieldKind, QuoteKind, Segment, SlotStatus } from './types'

export type ReapplyMode = 'ai' | 'editor'

export type SlotWhy =
  | 'literal'
  | 'alias'
  | 'real'
  | 'retired'
  | 'prefix'
  | 'name'
  | 'same-line'
  | 'edited-line'
  | 'detector'
  | 'table'

export type SlotWarning =
  | 'secret-in-output'
  | 'destructive-path'
  | 'cross-kind'
  | 'other-script'
  | 'parent-widening'
  | 'exposed'
  | `remap:${string}`

export interface SlotProposal {
  start: number
  end: number
  line: number
  fieldId: string | null
  kindGuess?: FieldKind
  quote: QuoteKind
  regex?: boolean
  conf: number
  status: Extract<SlotStatus, 'auto' | 'confirm' | 'candidate'>
  why: SlotWhy
  literal: string
  reason?: string
  bindingName?: string
  command?: string
  warnings: SlotWarning[]
  fromOtherScript?: boolean
  exposed?: boolean
  /** For path prefix matches: the AI's own filename/subfolder after the prefix. */
  suffix?: string
  /** Table blocks: column names. */
  columns?: string[]
}

export interface MissingField {
  fieldId: string
  /** 0-based lines in the previous version (example rendering) where the field sat. */
  prevLines: number[]
  /** A same-kind field whose occurrence count grew: maybe the AI merged the two. */
  remapCandidates: string[]
}

export interface UnknownValue {
  start: number
  end: number
  line: number
  literal: string
  kindGuess?: FieldKind
  reasons: string[]
  /** Syntactic context, so the value can become a slot when the user registers it. */
  quote: QuoteKind
  regex?: boolean
  bindingName?: string
}

export interface ReapplyInput {
  text: string
  language?: 'powershell' | 'plain'
  prev?: { segments: readonly Segment[] }
  /** Needles for this script: its own fields plus scope:'global'. */
  fields: readonly Field[]
  /** Fields of other scripts: hits are shown as candidates, never auto. */
  otherFields?: readonly Field[]
  real?: ReadonlyMap<string, string>
  retired?: ReadonlyArray<{ fieldId: string; value: string }>
  exclusions?: ReadonlyArray<{ fieldId: string; lineFp: string }>
  mode: ReapplyMode
  ns?: ExampleNamespace
  orgHostRegex?: RegExp
}

export interface ReapplyResult {
  slots: SlotProposal[]
  missing: MissingField[]
  unknown: UnknownValue[]
  flags: {
    realValuesFound: string[]
    retiredFound: string[]
    directionWarning: boolean
  }
  summary: { auto: number; confirm: number; candidate: number; missing: number; unknown: number }
}

interface Candidate extends SlotProposal {
  tok: Token | undefined
  field?: Field
}

const SEPARATOR_CHARS = ' \\/@.:,;="\'()[]{}<>|`$'
const SEPARATORS = new Set([...SEPARATOR_CHARS.split(''), '\t', '\n', '\r'])

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[\p{L}\p{N}_-]/u.test(c)
}

export interface Occurrence {
  start: number
  end: number
  text: string
  anchorRequired: boolean
  suffix?: string
}

/** All occurrences of `needle` in `logical` obeying the compare mode and the length rule. */
export function findOccurrences(logical: string, needle: string, compare: 'exact' | 'ci', rule: MatchRule): Occurrence[] {
  if (needle === '' || logical === '') return []
  const hay = compare === 'ci' ? logical.toLowerCase() : logical
  const nd = compare === 'ci' ? needle.toLowerCase() : needle
  if (rule === 'anchor-only') {
    return hay === nd ? [{ start: 0, end: logical.length, text: logical, anchorRequired: true }] : []
  }
  const out: Occurrence[] = []
  let from = 0
  while (from <= hay.length - nd.length) {
    const idx = hay.indexOf(nd, from)
    if (idx < 0) break
    const before = logical[idx - 1]
    const after = logical[idx + nd.length]
    const ok =
      rule === 'whole-token'
        ? (before === undefined || SEPARATORS.has(before)) && (after === undefined || SEPARATORS.has(after))
        : !isWordChar(before) && !isWordChar(after)
    if (ok) out.push({ start: idx, end: idx + nd.length, text: logical.slice(idx, idx + nd.length), anchorRequired: false })
    from = idx + 1
  }
  return out
}

const normPath = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

/** Path fields match on the example's directory prefix and keep the AI's own filename. */
export function findPathPrefixOccurrences(logical: string, prefix: string): Occurrence[] {
  const hay = normPath(logical)
  const nd = normPath(prefix)
  if (nd.length < 3) return []
  const out: Occurrence[] = []
  let from = 0
  while (from <= hay.length - nd.length) {
    const idx = hay.indexOf(nd, from)
    if (idx < 0) break
    const before = hay[idx - 1]
    const after = hay[idx + nd.length]
    const startOk = before === undefined || !/[A-Za-z0-9_\\]/.test(before)
    const endOk = after === undefined || after === '\\'
    if (startOk && endOk) {
      out.push({
        start: idx,
        end: idx + nd.length,
        text: logical.slice(idx, idx + nd.length),
        anchorRequired: false,
        suffix: logical.slice(idx + nd.length),
      })
    }
    from = idx + 1
  }
  return out
}

/** Normalised line with the value blanked, for 'not a secret here' exclusions. */
export function lineFingerprint(lineText: string, value: string): string {
  let s = lineText
  if (value) {
    const idx = s.toLowerCase().indexOf(value.toLowerCase())
    if (idx >= 0) s = s.slice(0, idx) + ' ' + s.slice(idx + value.length)
  }
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end
}

interface PrevSlotLocation {
  fieldId: string
  line: number
  col: number
  bindingName?: string
}

/** Locate every slot of the previous version in its example rendering (line/col). */
function locatePrevSlots(
  segments: readonly Segment[],
  fieldMap: ReadonlyMap<string, Field>,
): { text: string; slots: PrevSlotLocation[] } {
  const text = render(segments, 'example', { fields: fieldMap }).text
  const tokens = lex(text)
  const slots: PrevSlotLocation[] = []
  let line = 0
  let col = 0
  let offset = 0
  const advance = (s: string) => {
    for (const ch of s) {
      if (ch === '\n') {
        line++
        col = 0
      } else col++
    }
    offset += s.length
  }
  for (const seg of segments) {
    if (seg.t === 'text') {
      advance(seg.s)
      continue
    }
    const tok = tokens.find((t) => t.start <= offset && offset < t.end)
    const bindingName = tok?.binding ? normalizeAnchorName(tok.binding.name) : undefined
    slots.push({ fieldId: seg.fieldId, line, col, ...(bindingName !== undefined ? { bindingName } : {}) })
    advance(fieldMap.get(seg.fieldId)?.example ?? '')
  }
  return { text, slots }
}

/** Trigrams of the line with string literals collapsed, so a renamed variable still looks alike. */
function structureTrigrams(line: string): Set<string> {
  const structure = line
    .replace(/'(?:[^']|'')*'|"(?:[^"`]|`.)*"/g, "'S'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
  const out = new Set<string>()
  for (let i = 0; i + 3 <= structure.length; i++) out.add(structure.slice(i, i + 3))
  return out
}

function lineTokens(line: string): Set<string> {
  return new Set(line.split(/[^A-Za-z0-9_$@.\\-]+/).filter((t) => t.length > 1))
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

export function reapply(input: ReapplyInput): ReapplyResult {
  const text = input.text
  const language = input.language ?? 'powershell'
  const tokens = language === 'plain' ? lexPlain(text) : lex(text)
  const vtoks = valueTokens(tokens)
  const lines = text.split('\n')
  const ns = input.ns ?? DEFAULT_NAMESPACE
  const ownIds = new Set(input.fields.map((f) => f.id))
  const allFields = [...input.fields, ...(input.otherFields ?? [])].filter((f) => !f.tombstone)
  const fieldMap = new Map(allFields.map((f) => [f.id, f]))
  const pathFields = allFields.filter((f) => f.kind === 'path' || f.kind === 'unc')
  const isParentPath = (f: Field) =>
    pathFields.some((o) => o.id !== f.id && normPath(o.example).startsWith(normPath(f.example) + '\\'))
  const cands: Candidate[] = []
  const tokOf = (tok: Token) => ({ start: tok.contentStart ?? tok.start, end: tok.contentEnd ?? tok.end })

  // (a) literal anchors on logical values
  for (const f of allFields) {
    const fromOther = !ownIds.has(f.id)
    const needles: Array<{ value: string; why: SlotWhy }> = [{ value: f.example, why: 'literal' }]
    for (const a of f.aliases) if (!a.anchorOnly) needles.push({ value: a.value, why: 'alias' })
    const real = input.real?.get(f.id)
    if (real) needles.push({ value: real, why: 'real' })
    for (const r of input.retired ?? []) if (r.fieldId === f.id && r.value) needles.push({ value: r.value, why: 'retired' })
    const isPath = f.kind === 'path' || f.kind === 'unc'
    if (f.kind === 'blob') {
      // Whole-text search: a block spans many tokens and is emitted raw.
      for (const nd of needles) {
        if (nd.value.length < 8) continue
        let from = 0
        while (true) {
          const idx = text.indexOf(nd.value, from)
          if (idx < 0) break
          const exposed = nd.why === 'real' || nd.why === 'retired'
          cands.push({
            start: idx,
            end: idx + nd.value.length,
            line: lineOfOffset(text, idx),
            tok: undefined,
            field: f,
            fieldId: f.id,
            quote: 'comment',
            conf: 0.95,
            status: 'confirm',
            why: nd.why,
            literal: nd.value.slice(0, 60),
            warnings: [],
            fromOtherScript: fromOther,
            exposed,
          })
          from = idx + nd.value.length
        }
      }
      continue
    }
    for (const tok of vtoks) {
      const logical = tok.logical ?? ''
      if (!logical) continue
      for (const nd of needles) {
        const occs = isPath
          ? findPathPrefixOccurrences(logical, nd.value)
          : findOccurrences(logical, nd.value, f.compare, matchRuleFor(nd.value))
        for (const occ of occs) {
          const bname = tok.binding ? normalizeAnchorName(tok.binding.name) : undefined
          if (occ.anchorRequired && (!bname || !f.nameAnchors.includes(bname))) continue
          const lineText = lines[tok.line] ?? ''
          if (input.exclusions?.some((e) => e.fieldId === f.id && e.lineFp === lineFingerprint(lineText, occ.text))) continue
          const span = rawSpanForLogicalRange(tok, occ.start, occ.end, text)
          let conf = occ.anchorRequired ? 0.85 : occ.end - occ.start === logical.length ? 0.95 : 0.9
          const warnings: SlotWarning[] = []
          if (isPath && isParentPath(f)) {
            conf = Math.min(conf, 0.6)
            warnings.push('parent-widening')
          }
          const exposed = nd.why === 'real' || nd.why === 'retired'
          cands.push({
            ...span,
            line: tok.line,
            tok,
            field: f,
            fieldId: f.id,
            quote: tok.quote ?? 'bare',
            ...(tok.regexContext ? { regex: true } : {}),
            conf,
            status: 'confirm',
            why: isPath && !exposed ? 'prefix' : nd.why,
            literal: occ.text,
            ...(tok.binding ? { bindingName: tok.binding.name } : {}),
            ...(tok.command !== undefined ? { command: tok.command } : {}),
            warnings,
            fromOtherScript: fromOther,
            exposed,
            ...(occ.suffix !== undefined ? { suffix: occ.suffix } : {}),
          })
        }
      }
    }
  }

  // (b) name anchors: the AI changed the value but kept $Var / -Param / key.
  // Editor mode skips this: a different literal under a known name is a NEW real
  // value, and binding it to the field would silently swap it on render.
  for (const tok of input.mode === 'editor' ? [] : vtoks) {
    if (tok.kind === 'comment' || !tok.binding) continue
    if (cands.some((c) => c.tok === tok)) continue
    const logical = tok.logical ?? ''
    if (!logical.trim()) continue
    const bname = normalizeAnchorName(tok.binding.name)
    for (const f of input.fields) {
      if (f.tombstone) continue
      const byName = f.nameAnchors.includes(bname)
      if (!byName) continue
      const byAnchorAlias = f.aliases.some(
        (a) => a.anchorOnly && (f.compare === 'ci' ? a.value.toLowerCase() === logical.toLowerCase() : a.value === logical),
      )
      // A literal that IS another field's example/alias belongs to that field's literal hit.
      if (!byAnchorAlias && isOtherFieldsValue(logical, f.id, allFields)) continue
      cands.push({
        ...tokOf(tok),
        line: tok.line,
        tok,
        field: f,
        fieldId: f.id,
        quote: tok.quote ?? 'bare',
        ...(tok.regexContext ? { regex: true } : {}),
        conf: 0.65,
        status: 'confirm',
        why: 'name',
        literal: logical,
        bindingName: tok.binding.name,
        ...(tok.command !== undefined ? { command: tok.command } : {}),
        warnings: [],
      })
    }
  }

  // (c) line alignment against the previous version's example rendering
  let prevLocated: { text: string; slots: PrevSlotLocation[] } | undefined
  if (input.prev) {
    prevLocated = locatePrevSlots(input.prev.segments, fieldMap)
    const prevLines = prevLocated.text.split('\n')
    const lineSets = lines.map(lineTokens)
    const lineStructs = lines.map(structureTrigrams)
    for (const ps of input.mode === 'editor' ? [] : prevLocated.slots) {
      const f = fieldMap.get(ps.fieldId)
      if (!f || !ownIds.has(f.id)) continue
      const prevLine = prevLines[ps.line] ?? ''
      if (prevLine.trim() === '') continue
      const sameIdx = lines.map((l, i) => (l === prevLine ? i : -1)).filter((i) => i >= 0)
      if (sameIdx.length > 0) {
        for (const li of sameIdx) {
          if (cands.some((c) => c.fieldId === f.id && c.line === li)) continue
          const tok = tokenAtLineCol(tokens, li, ps.col)
          if (!tok || !isValueToken(tok) || !tok.logical) continue
          cands.push(candidateFromToken(tok, f, 0.85, 'same-line'))
        }
        continue
      }
      // edited line: most similar line near the old position
      const prevSet = lineTokens(prevLine)
      const prevStruct = structureTrigrams(prevLine)
      let best = -1
      let bestScore = 0.45
      for (let i = 0; i < lines.length; i++) {
        const score = Math.max(jaccard(prevSet, lineSets[i]!), jaccard(prevStruct, lineStructs[i]!))
        const distancePenalty = Math.min(0.2, Math.abs(i - ps.line) / 200)
        if (score - distancePenalty > bestScore) {
          bestScore = score - distancePenalty
          best = i
        }
      }
      if (best < 0 || cands.some((c) => c.fieldId === f.id && c.line === best)) continue
      const tok = pickTokenOnLine(tokens, best, ps, f, allFields)
      if (tok) cands.push(candidateFromToken(tok, f, 0.55, 'edited-line'))
    }
  }

  // (d) detectors: new fields, never auto
  const detectorOpts: DetectorOptions = { ns, ...(input.orgHostRegex ? { orgHostRegex: input.orgHostRegex } : {}), language }
  const detectorHits = detectCandidates(tokens, detectorOpts)
  for (const hit of detectorHits) {
    if (cands.some((c) => c.tok === hit.tok)) continue
    cands.push({
      start: hit.start,
      end: hit.end,
      line: hit.tok.line,
      tok: hit.tok,
      fieldId: null,
      kindGuess: hit.kind,
      quote: hit.tok.quote ?? 'bare',
      conf: hit.conf,
      status: 'candidate',
      why: 'detector',
      literal: hit.literal,
      reason: hit.reason,
      ...(hit.tok.binding ? { bindingName: hit.tok.binding.name } : {}),
      ...(hit.tok.command !== undefined ? { command: hit.tok.command } : {}),
      warnings: [],
    })
  }
  if (language === 'powershell') {
    for (const blob of detectTableBlocks(tokens, text)) {
      cands.push({
        start: blob.start,
        end: blob.end,
        line: blob.line,
        tok: undefined,
        fieldId: null,
        kindGuess: 'blob',
        quote: 'comment',
        conf: 0.5,
        status: 'candidate',
        why: 'table',
        literal: text.slice(blob.start, Math.min(blob.end, blob.start + 80)),
        reason: blob.reason,
        columns: blob.columns,
        warnings: [],
      })
    }
  }

  // resolve overlaps: longest span wins, then confidence
  const sorted = [...cands].sort((a, b) => b.end - b.start - (a.end - a.start) || b.conf - a.conf)
  const accepted: Candidate[] = []
  for (const c of sorted) {
    if (accepted.some((a) => overlaps(a, c))) continue
    accepted.push(c)
  }
  accepted.sort((a, b) => a.start - b.start)

  // statuses and warnings
  for (const c of accepted) {
    if (c.fieldId === null || !c.field) {
      c.status = 'candidate'
      continue
    }
    let status: Candidate['status'] = c.conf >= 0.85 ? 'auto' : 'confirm'
    if (c.fromOtherScript) {
      status = 'candidate'
      c.warnings.push('other-script')
    }
    const wholeToken = c.tok !== undefined && c.start === (c.tok.contentStart ?? c.tok.start) && c.end === (c.tok.contentEnd ?? c.tok.end)
    const bindKind = wholeToken && c.tok?.binding ? kindFromBindingName(c.tok.binding.name) : undefined
    if (bindKind && !kindCompatible(c.field.kind, bindKind)) {
      if (status === 'auto') status = 'confirm'
      c.warnings.push('cross-kind')
    }
    if ((c.field.kind === 'password' || c.field.kind === 'apiKey') && c.tok && isOutputContext(c.tok)) {
      if (status === 'auto') status = 'confirm'
      c.warnings.push('secret-in-output')
    }
    if ((c.field.kind === 'path' || c.field.kind === 'unc') && c.tok && isDestructiveContext(c.tok)) {
      if (status === 'auto') status = 'confirm'
      c.warnings.push('destructive-path')
    }
    if (c.exposed) c.warnings.push('exposed')
    c.status = status
  }

  // missing fields and merge detection
  const missing: MissingField[] = []
  if (prevLocated) {
    const prevCount = new Map<string, number[]>()
    for (const ps of prevLocated.slots) {
      if (!ownIds.has(ps.fieldId)) continue
      prevCount.set(ps.fieldId, [...(prevCount.get(ps.fieldId) ?? []), ps.line])
    }
    const nowCount = new Map<string, number>()
    for (const c of accepted) if (c.fieldId && c.status !== 'candidate') nowCount.set(c.fieldId, (nowCount.get(c.fieldId) ?? 0) + 1)
    for (const [fieldId, prevLines] of prevCount) {
      if (nowCount.has(fieldId)) continue
      const f = fieldMap.get(fieldId)
      const remapCandidates: string[] = []
      if (f) {
        for (const [otherId, count] of nowCount) {
          const g = fieldMap.get(otherId)
          if (!g || g.kind !== f.kind || otherId === fieldId) continue
          if (count > (prevCount.get(otherId)?.length ?? 0)) {
            remapCandidates.push(otherId)
            for (const c of accepted) {
              if (c.fieldId !== otherId) continue
              if (c.status === 'auto') c.status = 'confirm'
              c.warnings.push(`remap:${fieldId}`)
            }
          }
        }
      }
      missing.push({ fieldId, prevLines, remapCandidates })
    }
  }

  // editor mode: unknown real-looking values
  let unknown: UnknownValue[] = []
  if (input.mode === 'editor') {
    unknown = scanUnknown(vtoks, accepted, allFields, input.real, ns, detectorHits)
    // detector candidates with conf >= 0.4 are unknown real values here, not blue candidates
    for (let i = accepted.length - 1; i >= 0; i--) {
      const c = accepted[i]!
      if (c.fieldId === null && c.why === 'detector' && c.conf >= 0.4) {
        if (!unknown.some((u) => overlaps(u, c))) {
          unknown.push({
            start: c.start,
            end: c.end,
            line: c.line,
            literal: c.literal,
            ...(c.kindGuess ? { kindGuess: c.kindGuess } : {}),
            reasons: [c.reason ?? 'detector'],
            quote: c.quote,
            ...(c.regex ? { regex: true } : {}),
            ...(c.bindingName ? { bindingName: c.bindingName } : {}),
          })
        }
        accepted.splice(i, 1)
      }
    }
    unknown.sort((a, b) => a.start - b.start)
  }

  const realValuesFound = [...new Set(accepted.filter((c) => c.why === 'real').map((c) => c.fieldId!))]
  const retiredFound = [...new Set(accepted.filter((c) => c.why === 'retired').map((c) => c.fieldId!))]
  const slots: SlotProposal[] = accepted.map(({ tok: _tok, field: _field, ...rest }) => rest)
  const summary = {
    auto: slots.filter((s) => s.status === 'auto').length,
    confirm: slots.filter((s) => s.status === 'confirm').length,
    candidate: slots.filter((s) => s.status === 'candidate').length,
    missing: missing.length,
    unknown: unknown.length,
  }
  return {
    slots,
    missing,
    unknown,
    flags: {
      realValuesFound,
      retiredFound,
      directionWarning: input.mode === 'ai' && (realValuesFound.length > 0 || retiredFound.length > 0),
    },
    summary,
  }
}

function lineOfOffset(text: string, offset: number): number {
  let line = 0
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

function isValueToken(tok: Token): boolean {
  return tok.kind === 'string' || tok.kind === 'bareword' || tok.kind === 'number'
}

function tokenAtLineCol(tokens: readonly Token[], line: number, col: number): Token | undefined {
  const onLine = tokens.filter((t) => t.line === line && isValueToken(t))
  const lineStart = tokens.find((t) => t.line === line)?.start ?? 0
  const target = lineStart + col
  return (
    onLine.find((t) => t.start <= target && target < t.end) ??
    [...onLine].sort((a, b) => Math.abs(a.start - target) - Math.abs(b.start - target))[0]
  )
}

function isOtherFieldsValue(logical: string, fieldId: string, fields: readonly Field[]): boolean {
  const v = logical.toLowerCase()
  return fields.some(
    (o) => o.id !== fieldId && (o.example.toLowerCase() === v || o.aliases.some((a) => a.value.toLowerCase() === v)),
  )
}

function pickTokenOnLine(
  tokens: readonly Token[],
  line: number,
  ps: PrevSlotLocation,
  f: Field,
  fields: readonly Field[],
): Token | undefined {
  const onLine = tokens.filter(
    (t) =>
      t.line === line &&
      isValueToken(t) &&
      (t.logical ?? '').trim() !== '' &&
      // plausible values only: strings, or barewords/numbers that are bound and are not the command itself
      (t.kind === 'string' || (t.binding !== undefined && t.raw !== t.command)),
  )
  const usable = onLine.filter((t) => !isOtherFieldsValue(t.logical ?? '', f.id, fields))
  if (usable.length === 0) return undefined
  if (ps.bindingName) {
    const byName = usable.find((t) => t.binding && normalizeAnchorName(t.binding.name) === ps.bindingName)
    if (byName) return byName
  }
  const lineStart = tokens.find((t) => t.line === line)?.start ?? 0
  const target = lineStart + ps.col
  return [...usable].sort((a, b) => Math.abs(a.start - target) - Math.abs(b.start - target))[0]
}

function candidateFromToken(tok: Token, f: Field, conf: number, why: SlotWhy): Candidate {
  return {
    start: tok.contentStart ?? tok.start,
    end: tok.contentEnd ?? tok.end,
    line: tok.line,
    tok,
    field: f,
    fieldId: f.id,
    quote: tok.quote ?? 'bare',
    ...(tok.regexContext ? { regex: true } : {}),
    conf,
    status: 'confirm',
    why,
    literal: tok.logical ?? tok.raw,
    ...(tok.binding ? { bindingName: tok.binding.name } : {}),
    ...(tok.command !== undefined ? { command: tok.command } : {}),
    warnings: [],
  }
}

function scanUnknown(
  vtoks: readonly Token[],
  accepted: readonly Candidate[],
  fields: readonly Field[],
  real: ReadonlyMap<string, string> | undefined,
  ns: ExampleNamespace,
  detectorHits: ReturnType<typeof detectCandidates>,
): UnknownValue[] {
  const out: UnknownValue[] = []
  const suffixes = new Set<string>()
  const reals: Array<{ id: string; value: string; ci: boolean }> = []
  for (const f of fields) {
    const r = real?.get(f.id)
    if (!r) continue
    reals.push({ id: f.id, value: r, ci: f.compare === 'ci' })
    const lower = r.toLowerCase()
    if (f.kind === 'domain' && lower.length >= 4) suffixes.add(lower)
    if (f.kind === 'email' && lower.includes('@')) suffixes.add(lower.slice(lower.indexOf('@') + 1))
    if (f.kind === 'server' && lower.includes('.')) suffixes.add(lower.slice(lower.indexOf('.') + 1))
  }
  for (const tok of vtoks) {
    if (tok.kind === 'comment') continue
    const span = { start: tok.contentStart ?? tok.start, end: tok.contentEnd ?? tok.end }
    if (accepted.some((a) => a.fieldId !== null && overlaps(a, span))) continue
    const v = (tok.logical ?? '').trim()
    if (v.length < 3 || isInExampleNamespace(v, ns)) continue
    const reasons: string[] = []
    const det = detectorHits.find((h) => h.tok === tok)
    const lower = v.toLowerCase()
    for (const s of suffixes) if (s.length >= 4 && lower.includes(s)) reasons.push(`known-domain:${s}`)
    const bindKind = tok.binding ? kindFromBindingName(tok.binding.name) : undefined
    if (v.length >= 12 && (bindKind === 'password' || bindKind === 'apiKey') && shannonEntropy(v) > 3.5) reasons.push('high-entropy')
    for (const run of base64Runs(v)) {
      for (const decoded of decodeBase64Variants(run.run)) {
        for (const r of reals) {
          const hit = r.ci ? decoded.toLowerCase().includes(r.value.toLowerCase()) : decoded.includes(r.value)
          if (hit) reasons.push(`base64-contains:${r.id}`)
        }
      }
    }
    if (reasons.length === 0) continue
    out.push({
      ...span,
      line: tok.line,
      literal: v,
      ...(det ? { kindGuess: det.kind } : {}),
      reasons: [...new Set(reasons)],
      quote: tok.quote ?? 'bare',
      ...(tok.regexContext ? { regex: true } : {}),
      ...(tok.binding ? { bindingName: tok.binding.name } : {}),
    })
  }
  return out
}

/** Build the version's segments from the accepted proposals. */
export function applyProposals(text: string, accepted: readonly SlotProposal[]): Segment[] {
  const slots: RawSlot[] = accepted
    .filter((p) => p.fieldId !== null)
    .map((p) => ({
      start: p.start,
      end: p.end,
      fieldId: p.fieldId!,
      quote: p.quote,
      conf: p.conf,
      status: p.status === 'candidate' ? 'confirm' : p.status,
      ...(p.regex ? { regex: true } : {}),
    }))
  return spliceSlots(text, slots)
}

export interface Learned {
  nameAnchors: string[]
  alias?: FieldAlias
}

/**
 * What a field learns from an accepted proposal. Aliases are learned only in
 * AI mode (an editor paste would store real variants) and only when the
 * literal passes the example rules; otherwise it becomes anchor-only.
 */
export function learnFromAccepted(
  field: Field,
  proposal: SlotProposal,
  mode: ReapplyMode,
  vault: { otherExamples: readonly string[]; realValues: readonly string[] },
): Learned {
  const anchors = new Set(field.nameAnchors)
  if (proposal.bindingName) anchors.add(normalizeAnchorName(proposal.bindingName))
  const learned: Learned = { nameAnchors: [...anchors] }
  if (mode !== 'ai') return learned
  if (proposal.why !== 'name' && proposal.why !== 'edited-line' && proposal.why !== 'same-line') return learned
  const literal = proposal.literal
  if (!literal || literal.toLowerCase() === field.example.toLowerCase()) return learned
  if (field.aliases.some((a) => a.value.toLowerCase() === literal.toLowerCase())) return learned
  const problems = validateExample(literal, { kind: field.kind, otherExamples: vault.otherExamples, realValues: vault.realValues })
  const anchorOnly = problems.length > 0 || ALIAS_STOPLIST.has(literal.toLowerCase())
  learned.alias = { value: literal, anchorOnly }
  return learned
}
