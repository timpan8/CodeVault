/**
 * Outgoing leak guard. Runs on everything that leaves as "for AI": the
 * sanitized rendering, sanitized exports, diff copies, the scratch pane, and
 * on notes/prompts/titles/field names at save time.
 *
 * Deliberately dumb and exhaustive, independent of the matcher: even if every
 * heuristic in reapply is wrong, a real value cannot leave through here.
 *
 * Pass 1: every real and retired value in the WHOLE vault, plus encoded
 *         variants and derived domain suffixes, plus recursive base64 decoding.
 *         Never allow-listable.
 * Pass 2: structural detectors (emails, non-example domains, IPs outside
 *         TEST-NET, GUIDs, UNC, -Server literals, org host pattern,
 *         personnummer, thumbprints, JWT, connection-string passwords,
 *         ConvertTo-SecureString literals, high-entropy strings). Allow-listable.
 * Pass 3: residual template markers.
 */
import { lex, lexPlain, type Token } from './lexer/powershell'
import { matchRuleFor } from './fields'
import { base64Runs, decodeBase64Variants, encodedVariants, shannonEntropy } from './encoding'
import { DEFAULT_NAMESPACE, isInExampleNamespace, type ExampleNamespace } from './examples'
import {
  ANY_IP_RE,
  EMAIL_RE,
  FQDN_RE,
  GUID_RE,
  JWT_RE,
  THUMBPRINT_RE,
  UNC_RE,
  isPathShaped,
  isProviderPath,
  isUrl,
  kindFromBindingName,
  looksLikePersonnummer,
} from './detectors'
import { SLOT_CLOSE, SLOT_OPEN } from './template'
import type { Field, FieldKind } from './types'

export interface GuardInput {
  text: string
  /** All fields in the vault, every script. */
  fields: readonly Field[]
  /** Decrypted real values for all fields. */
  real: ReadonlyMap<string, string>
  retired?: ReadonlyArray<{ fieldId: string; value: string }>
  allowlist?: ReadonlyArray<{ value: string; expiresAt?: string }>
  now?: string
  ns?: ExampleNamespace
  orgHostRegex?: RegExp
  language?: 'powershell' | 'plain'
}

export type GuardVariant =
  | 'plain'
  | 'ci'
  | 'encoded'
  | 'decoded-base64'
  | 'domain-suffix'
  | 'retired'

export interface GuardFinding {
  pass: 1 | 2 | 3
  start: number
  end: number
  line: number
  /** Text as it appears in the output. UI masks it for secret kinds. */
  matched: string
  fieldId?: string
  variant?: GuardVariant
  kind?: FieldKind
  reason: string
  allowlistable: boolean
}

export interface GuardResult {
  findings: GuardFinding[]
  blocked: boolean
}

const TEST_NET = /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/
const FAKE_GUID = /^\{?11111111-2222-4333-8444-\d{12}\}?$/i
const KNOWN_TLDS = new Set(
  'com net org se local corp internal io dev nu dk no fi de uk eu onmicrosoft cloud app lan home ad int biz info gov edu ch at nl be pl es it fr ru cn jp br au ca nz ie is'.split(' '),
)
const SERVER_PARAMS = /^(server|computername|domaincontroller|smtpserver|serverinstance|hostname|host|dc|vcenter)$/i
const CONNECTION_STRING_RE = /(password|pwd|secret)\s*=\s*([^;'"\s]{3,})/i
const ENTROPY_MIN_LEN = 20
const ENTROPY_THRESHOLD = 3.5
const MAX_DECODE_DEPTH = 2

function lineOf(text: string, offset: number): number {
  let line = 0
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[\p{L}\p{N}_]/u.test(c)
}

const SEP = new Set(' \t\n\r\\/@.:,;="\'()[]{}<>|`$'.split(''))

/** Find all occurrences respecting the length rule; returns [start, end) pairs. */
function scanNeedle(hay: string, needle: string, ci: boolean): Array<[number, number]> {
  const rule = matchRuleFor(needle)
  if (rule === 'anchor-only') return []
  const h = ci ? hay.toLowerCase() : hay
  const n = ci ? needle.toLowerCase() : needle
  const out: Array<[number, number]> = []
  let from = 0
  while (from <= h.length - n.length) {
    const idx = h.indexOf(n, from)
    if (idx < 0) break
    const before = hay[idx - 1]
    const after = hay[idx + n.length]
    const ok =
      rule === 'whole-token'
        ? (before === undefined || SEP.has(before)) && (after === undefined || SEP.has(after))
        : !isWordChar(before) && !isWordChar(after)
    if (ok) out.push([idx, idx + n.length])
    from = idx + 1
  }
  return out
}

interface Needle {
  fieldId: string
  value: string
  ci: boolean
  variant: GuardVariant
}

function buildNeedles(input: GuardInput): Needle[] {
  const needles: Needle[] = []
  const seen = new Set<string>()
  const push = (n: Needle) => {
    const key = `${n.fieldId}|${n.variant}|${n.ci ? n.value.toLowerCase() : n.value}`
    if (seen.has(key) || n.value.length < 4) return
    seen.add(key)
    needles.push(n)
  }
  for (const f of input.fields) {
    const real = input.real.get(f.id)
    if (!real) continue
    const ci = f.compare === 'ci'
    push({ fieldId: f.id, value: real, ci, variant: ci ? 'ci' : 'plain' })
    for (const v of encodedVariants(real)) push({ fieldId: f.id, value: v, ci: false, variant: 'encoded' })
    const lower = real.toLowerCase()
    let suffix: string | undefined
    if (f.kind === 'email' && lower.includes('@')) suffix = lower.slice(lower.indexOf('@') + 1)
    else if (f.kind === 'server' && lower.includes('.')) suffix = lower.slice(lower.indexOf('.') + 1)
    else if (f.kind === 'domain') suffix = lower
    if (suffix && suffix.length >= 4 && suffix.includes('.') && !isInExampleNamespace(suffix, input.ns ?? DEFAULT_NAMESPACE)) {
      push({ fieldId: f.id, value: suffix, ci: true, variant: 'domain-suffix' })
    }
  }
  for (const r of input.retired ?? []) {
    if (!r.value) continue
    const f = input.fields.find((x) => x.id === r.fieldId)
    push({ fieldId: r.fieldId, value: r.value, ci: f?.compare === 'ci', variant: 'retired' })
    for (const v of encodedVariants(r.value)) push({ fieldId: r.fieldId, value: v, ci: false, variant: 'encoded' })
  }
  return needles
}

function pass1(text: string, needles: readonly Needle[], input: GuardInput): GuardFinding[] {
  const findings: GuardFinding[] = []
  const fieldName = (id: string) => input.fields.find((f) => f.id === id)?.name ?? id
  for (const n of needles) {
    for (const [start, end] of scanNeedle(text, n.value, n.ci)) {
      findings.push({
        pass: 1,
        start,
        end,
        line: lineOf(text, start),
        matched: text.slice(start, end),
        fieldId: n.fieldId,
        variant: n.variant,
        reason: n.variant === 'domain-suffix' ? `domain of ${fieldName(n.fieldId)}` : `real value of ${fieldName(n.fieldId)}${n.variant === 'retired' ? ' (retired)' : n.variant === 'encoded' ? ' (encoded)' : ''}`,
        allowlistable: false,
      })
    }
  }
  // recursive base64 decoding
  const scanDecoded = (hay: string, depth: number, anchor: { start: number; end: number }) => {
    if (depth > MAX_DECODE_DEPTH) return
    for (const run of base64Runs(hay)) {
      for (const decoded of decodeBase64Variants(run.run)) {
        for (const n of needles) {
          if (n.variant === 'encoded') continue
          if (scanNeedle(decoded, n.value, n.ci).length > 0) {
            findings.push({
              pass: 1,
              start: anchor.start,
              end: anchor.end,
              line: lineOf(text, anchor.start),
              matched: text.slice(anchor.start, anchor.end),
              fieldId: n.fieldId,
              variant: 'decoded-base64',
              reason: `decoded content contains ${fieldName(n.fieldId)}`,
              allowlistable: false,
            })
          }
        }
        scanDecoded(decoded, depth + 1, anchor)
      }
    }
  }
  for (const run of base64Runs(text)) scanDecoded(run.run, 1, { start: run.start, end: run.end })
  return dedupe(findings)
}

function dedupe(findings: GuardFinding[]): GuardFinding[] {
  const seen = new Set<string>()
  const out: GuardFinding[] = []
  for (const f of findings) {
    const key = `${f.pass}|${f.start}|${f.end}|${f.fieldId ?? ''}|${f.reason}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(f)
  }
  return out
}

function pass2(text: string, tokens: readonly Token[], input: GuardInput): GuardFinding[] {
  const ns = input.ns ?? DEFAULT_NAMESPACE
  const findings: GuardFinding[] = []
  const add = (tok: Token, kind: FieldKind | undefined, reason: string, span?: { start: number; end: number }) => {
    const start = span?.start ?? tok.contentStart ?? tok.start
    const end = span?.end ?? tok.contentEnd ?? tok.end
    findings.push({
      pass: 2,
      start,
      end,
      line: tok.line,
      matched: text.slice(start, end),
      ...(kind ? { kind } : {}),
      reason,
      allowlistable: true,
    })
  }
  for (const tok of tokens) {
    if (tok.kind !== 'string' && tok.kind !== 'bareword' && tok.kind !== 'comment') continue
    const raw = tok.logical ?? ''
    // comments: scan words inside for emails/UNC/IPs
    const words = tok.kind === 'comment' ? raw.split(/[\s,;()]+/).filter((w) => w.length >= 4) : [raw.trim()]
    for (const v of words) {
      if (v.length < 4 || isInExampleNamespace(v, ns)) continue
      const bindKind = tok.binding ? kindFromBindingName(tok.binding.name) : undefined
      const cmd = tok.command?.toLowerCase()
      if (UNC_RE.test(v)) {
        add(tok, 'unc', 'UNC path')
        continue
      }
      if (EMAIL_RE.test(v)) {
        add(tok, 'email', 'email address')
        continue
      }
      if (ANY_IP_RE.test(v) && !TEST_NET.test(v)) {
        add(tok, 'ip', 'IP address outside TEST-NET')
        continue
      }
      if (GUID_RE.test(v) && !FAKE_GUID.test(v)) {
        add(tok, 'tenantId', 'GUID outside the example pattern')
        continue
      }
      if (JWT_RE.test(v)) {
        add(tok, 'apiKey', 'JWT token')
        continue
      }
      if (THUMBPRINT_RE.test(v)) {
        add(tok, 'apiKey', 'certificate thumbprint')
        continue
      }
      if (looksLikePersonnummer(v)) {
        add(tok, 'custom', 'Swedish personnummer')
        continue
      }
      if (tok.kind !== 'comment') {
        const cs = CONNECTION_STRING_RE.exec(v)
        if (cs && cs.index !== undefined) {
          add(tok, 'password', 'password inside connection string')
          continue
        }
        if (cmd === 'convertto-securestring' && (tok.binding?.name === 'String' || tok.binding?.index === 0)) {
          add(tok, 'password', 'plaintext literal to ConvertTo-SecureString')
          continue
        }
        if (tok.binding?.kind === 'param' && SERVER_PARAMS.test(tok.binding.name) && !isPathShaped(v) && !isUrl(v)) {
          add(tok, 'server', `literal argument to -${tok.binding.name}`)
          continue
        }
        if (input.orgHostRegex && input.orgHostRegex.test(v)) {
          add(tok, 'server', 'matches organisation host pattern')
          continue
        }
        if (isPathShaped(v)) {
          if (/[\\/]Users[\\/][^\\/]+/i.test(v)) add(tok, 'path', 'user profile path')
          continue
        }
        if (isProviderPath(v) || isUrl(v)) continue
        if (FQDN_RE.test(v) && v.includes('.') && !/\.(ps1|psm1|psd1|csv|txt|log|json|xml|exe|dll|zip|cmd|bat|md|html|htm|xlsx|docx|yaml|yml)$/i.test(v)) {
          const labels = v.split('.').filter(Boolean)
          const tld = labels[labels.length - 1]!.toLowerCase()
          const serverish = bindKind === 'server' || bindKind === 'domain' || bindKind === 'email'
          if (labels.length >= 2 && (KNOWN_TLDS.has(tld) || serverish) && cmd !== 'import-module' && cmd !== 'using') {
            add(tok, 'server', 'host or domain name outside the example namespace')
            continue
          }
        }
        if (tok.kind === 'string' && v.length >= ENTROPY_MIN_LEN && !/\s/.test(v) && shannonEntropy(v) > ENTROPY_THRESHOLD) {
          const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(v)).length
          const secretish = bindKind === 'password' || bindKind === 'apiKey'
          if (secretish || (classes >= 3 && /\d/.test(v))) add(tok, 'apiKey', 'high-entropy string')
          continue
        }
      }
    }
  }
  return findings
}

function pass3(text: string, input: GuardInput): GuardFinding[] {
  const findings: GuardFinding[] = []
  const markerRe = new RegExp(`${SLOT_OPEN}[^${SLOT_CLOSE}]*${SLOT_CLOSE}|${SLOT_OPEN}|${SLOT_CLOSE}`, 'g')
  for (const m of text.matchAll(markerRe)) {
    findings.push({ pass: 3, start: m.index, end: m.index + m[0].length, line: lineOf(text, m.index), matched: m[0], reason: 'residual template marker', allowlistable: false })
  }
  for (const f of input.fields) {
    const token = `[${f.name}]`
    let from = 0
    while (true) {
      const idx = text.indexOf(token, from)
      if (idx < 0) break
      findings.push({ pass: 3, start: idx, end: idx + token.length, line: lineOf(text, idx), matched: token, fieldId: f.id, reason: 'field name token left in text', allowlistable: false })
      from = idx + token.length
    }
  }
  return findings
}

function allowlisted(value: string, input: GuardInput): boolean {
  const now = input.now ?? new Date().toISOString()
  const v = value.toLowerCase()
  return (input.allowlist ?? []).some((a) => a.value.toLowerCase() === v && (!a.expiresAt || a.expiresAt > now))
}

export function guard(input: GuardInput): GuardResult {
  const text = input.text
  const needles = buildNeedles(input)
  const tokens = input.language === 'plain' ? lexPlain(text) : lex(text)
  const p1 = pass1(text, needles, input)
  const p2 = pass2(text, tokens, input).filter((f) => !allowlisted(f.matched, input))
  const p3 = pass3(text, input)
  // A pass-2 finding fully inside a pass-1 finding is redundant.
  const p2Filtered = p2.filter((f) => !p1.some((g) => g.start <= f.start && f.end <= g.end))
  const findings = [...p1, ...p2Filtered, ...p3].sort((a, b) => a.start - b.start || a.pass - b.pass)
  return { findings, blocked: findings.length > 0 }
}

/** Convenience for short texts (titles, notes, field names): pass 1 and 2 only. */
export function guardShortText(text: string, input: Omit<GuardInput, 'text'>): GuardResult {
  const r = guard({ ...input, text, language: 'plain' })
  return { findings: r.findings.filter((f) => f.pass !== 3), blocked: r.findings.some((f) => f.pass !== 3) }
}
