/**
 * Kind detectors: propose NEW fields from binding names and value shapes.
 * They never auto-apply; the review screen shows them as candidates (AI
 * mode) or unknown real values (editor mode).
 */
import type { Token } from './lexer/powershell'
import type { FieldKind } from './types'
import { DEFAULT_NAMESPACE, isInExampleNamespace, type ExampleNamespace } from './examples'

export const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/
export const GUID_RE = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i
export const PRIVATE_IP_RE = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/
export const ANY_IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/
export const UNC_RE = /^\\\\[^\\\s]+\\[^\\\s]+/
export const FQDN_RE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+){1,}\.?$/
export const JWT_RE = /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/
export const THUMBPRINT_RE = /^[0-9a-f]{40}$/i
export const DRIVE_PATH_RE = /^[A-Za-z]:[\\/]/
export const PROVIDER_PATH_RE = /^(HKLM|HKCU|HKCR|HKU|HKCC|Cert|WSMan|AD|Env|Variable|Function|Alias|Registry|Microsoft\.PowerShell\.[A-Za-z]+\\[A-Za-z]+):/i
export const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i

const VALUE_STOPLIST = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  'true',
  'false',
  'null',
  'none',
  'yes',
  'no',
  'stop',
  'continue',
  'silentlycontinue',
  'ignore',
  'inquire',
  'utf8',
  'utf-8',
  'ascii',
  'unicode',
  'default',
])

export const OUTPUT_COMMANDS = new Set(
  [
    'write-host',
    'write-output',
    'write-verbose',
    'write-debug',
    'write-information',
    'write-warning',
    'write-error',
    'out-file',
    'add-content',
    'set-content',
    'tee-object',
    'write-log',
    'out-string',
    'write-eventlog',
  ],
)

export const DESTRUCTIVE_COMMANDS = new Set(['remove-item', 'clear-content', 'move-item', 'rename-item', 'remove-itemproperty', 'clear-item'])

export const PATH_SINK_COMMANDS = new Set([
  'export-csv',
  'export-clixml',
  'out-file',
  'set-content',
  'add-content',
  'start-transcript',
  'new-item',
  'copy-item',
  'move-item',
  'compress-archive',
  'expand-archive',
  'import-csv',
  'get-content',
  'import-clixml',
  'invoke-webrequest',
  'test-path',
  'join-path',
  'set-location',
  'push-location',
])

/** Best-guess kind from a binding name ($Var, -Param, key). Priority matters. */
export function kindFromBindingName(name: string): FieldKind | undefined {
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!n) return undefined
  if (/pass(word|wd|phrase)?$|passwd|^pwd$|pwd$|secret|^pw$|credpass/.test(n)) return 'password'
  if (/token|apikey|accesskey|bearer|authorization|^key$|clientkey|sharedkey/.test(n)) return 'apiKey'
  if (/tenant|clientid|appid|applicationid|subscription(id)?$|objectid/.test(n)) return 'tenantId'
  if (/computer(name)?$|server|hostname|^host$|domaincontroller|^dc$|smtp|sqlinstance|serverinstance|vcenter|^fqdn$|^target$/.test(n)) return 'server'
  if (/domain|netbios|realm|dnsname/.test(n)) return 'domain'
  if (/user(name)?$|^user|identity|samaccountname|^upn$|userprincipalname|login|account(name)?$|^uid$|credential/.test(n)) return 'username'
  if (/mail|email|^from$|^to$|recipient|sender/.test(n)) return 'email'
  if (/path|file|folder|dir(ectory)?$|root|destination|outfile|^log|logfile|output|export|source|location|home|share/.test(n)) return 'path'
  return undefined
}

export function isPathShaped(v: string): boolean {
  return (DRIVE_PATH_RE.test(v) || UNC_RE.test(v)) && !PROVIDER_PATH_RE.test(v)
}

export function isProviderPath(v: string): boolean {
  return PROVIDER_PATH_RE.test(v)
}

export function isUrl(v: string): boolean {
  return URL_RE.test(v)
}

/** Swedish personnummer with Luhn check (YYMMDD-XXXX, YYYYMMDD-XXXX, with or without separator). */
export function looksLikePersonnummer(v: string): boolean {
  const m = /^(\d{2})?(\d{2})(\d{2})(\d{2})[-+]?(\d{4})$/.exec(v.trim())
  if (!m) return false
  const digits = (m[2]! + m[3]! + m[4]! + m[5]!).split('').map(Number)
  const month = Number(m[3])
  const day = Number(m[4])
  if (month < 1 || month > 12 || day < 1 || day > 91) return false
  let sum = 0
  for (let i = 0; i < 10; i++) {
    let d = digits[i]!
    if (i % 2 === 0) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

export function isOutputContext(tok: Token): boolean {
  if (tok.kind === 'comment') return true
  const cmd = tok.command?.toLowerCase()
  if (cmd && (OUTPUT_COMMANDS.has(cmd) || /log/.test(cmd))) return true
  if (tok.binding?.kind === 'param' && /^message$/i.test(tok.binding.name)) return true
  return false
}

export function isDestructiveContext(tok: Token): boolean {
  const cmd = tok.command?.toLowerCase()
  return cmd !== undefined && DESTRUCTIVE_COMMANDS.has(cmd)
}

export interface DetectorHit {
  tok: Token
  /** Raw span in the source text. */
  start: number
  end: number
  kind: FieldKind
  conf: number
  reason: string
  literal: string
  /** Structural hits (UNC, -Server literal, personnummer) are reported regardless of configuration. */
  structural: boolean
}

export interface DetectorOptions {
  ns?: ExampleNamespace
  /** Organisation host-name pattern, e.g. /^(SRV|DC|FS)-/i */
  orgHostRegex?: RegExp
  language?: 'powershell' | 'plain'
}

function span(tok: Token): { start: number; end: number } {
  return { start: tok.contentStart ?? tok.start, end: tok.contentEnd ?? tok.end }
}

export function detectCandidates(tokens: readonly Token[], opts: DetectorOptions = {}): DetectorHit[] {
  const ns = opts.ns ?? DEFAULT_NAMESPACE
  const hits: DetectorHit[] = []
  for (const tok of tokens) {
    if (tok.kind !== 'string' && tok.kind !== 'bareword' && tok.kind !== 'number') continue
    const v = (tok.logical ?? '').trim()
    if (v.length < 3 || VALUE_STOPLIST.has(v.toLowerCase())) continue
    if (isInExampleNamespace(v, ns)) continue
    if (v.startsWith('$') || v.startsWith('@')) continue
    const hit = classify(tok, v, opts)
    if (hit) hits.push({ tok, ...span(tok), literal: v, ...hit })
  }
  return hits
}

function classify(
  tok: Token,
  v: string,
  opts: DetectorOptions,
): { kind: FieldKind; conf: number; reason: string; structural: boolean } | undefined {
  const bindName = tok.binding?.name
  const bindKind = bindName ? kindFromBindingName(bindName) : undefined
  const cmd = tok.command?.toLowerCase()
  const isParam = tok.binding?.kind === 'param'
  const isComment = tok.kind === 'comment'
  if (isComment) return undefined

  if (cmd === 'convertto-securestring' && (tok.binding?.name === 'String' || tok.binding?.index === 0 || bindKind === 'password')) {
    return { kind: 'password', conf: 0.5, reason: 'ConvertTo-SecureString literal', structural: true }
  }
  if (bindKind === 'password' && v.length >= 4 && tok.kind === 'string') {
    return { kind: 'password', conf: 0.5, reason: `bound to ${bindName}`, structural: false }
  }
  if (JWT_RE.test(v)) return { kind: 'apiKey', conf: 0.5, reason: 'JWT shape', structural: true }
  if (bindKind === 'apiKey' && v.length >= 8) return { kind: 'apiKey', conf: 0.5, reason: `bound to ${bindName}`, structural: false }
  if (GUID_RE.test(v)) {
    return bindKind === 'tenantId'
      ? { kind: 'tenantId', conf: 0.5, reason: `GUID bound to ${bindName}`, structural: true }
      : { kind: 'tenantId', conf: 0.35, reason: 'GUID shape', structural: false }
  }
  if (THUMBPRINT_RE.test(v)) return { kind: 'apiKey', conf: 0.45, reason: 'certificate thumbprint', structural: true }
  if (UNC_RE.test(v)) return { kind: 'unc', conf: 0.45, reason: 'UNC path', structural: true }
  if (EMAIL_RE.test(v)) return { kind: 'email', conf: 0.4, reason: 'email shape', structural: true }
  if (PRIVATE_IP_RE.test(v)) return { kind: 'ip', conf: 0.4, reason: 'private IP', structural: true }
  if (looksLikePersonnummer(v)) return { kind: 'custom', conf: 0.5, reason: 'personnummer', structural: true }
  if (isPathShaped(v)) {
    if (bindKind === 'path' || (cmd && PATH_SINK_COMMANDS.has(cmd))) {
      return { kind: 'path', conf: 0.35, reason: cmd ? `path argument to ${tok.command}` : `bound to ${bindName}`, structural: false }
    }
    return { kind: 'path', conf: 0.3, reason: 'path shape', structural: false }
  }
  if (isProviderPath(v) || isUrl(v)) return undefined
  if (bindKind === 'server' && !v.includes(' ')) {
    const structural = isParam && /^(server|computername|domaincontroller|smtpserver|serverinstance)$/i.test(bindName ?? '')
    return { kind: 'server', conf: 0.45, reason: `bound to ${bindName}`, structural }
  }
  if (opts.orgHostRegex && opts.orgHostRegex.test(v)) return { kind: 'server', conf: 0.5, reason: 'matches organisation host pattern', structural: true }
  if (FQDN_RE.test(v) && v.includes('.') && !/\.(ps1|psm1|psd1|csv|txt|log|json|xml|exe|dll|zip|cmd|bat|md|html|htm|xlsx|docx)$/i.test(v)) {
    const labels = v.split('.').filter(Boolean)
    if (labels.length >= 2 && labels.every((l) => /^[A-Za-z0-9-]+$/.test(l)) && !/^\d+$/.test(labels[labels.length - 1]!)) {
      return { kind: 'server', conf: 0.4, reason: 'FQDN shape', structural: false }
    }
  }
  if (bindKind === 'domain') return { kind: 'domain', conf: 0.4, reason: `bound to ${bindName}`, structural: false }
  if (bindKind === 'username' && !v.includes(' ')) return { kind: 'username', conf: 0.4, reason: `bound to ${bindName}`, structural: false }
  if (bindKind === 'email') return undefined
  if (ANY_IP_RE.test(v)) return { kind: 'ip', conf: 0.3, reason: 'IP shape', structural: false }
  return undefined
}

/** Is `bindKind` (from the binding name) compatible with the field kind? */
export function kindCompatible(fieldKind: FieldKind, bindKind: FieldKind | undefined): boolean {
  if (!bindKind || bindKind === fieldKind) return true
  const groups: Record<string, readonly FieldKind[]> = {
    identity: ['username', 'email'],
    host: ['server', 'domain', 'ip', 'unc'],
    secret: ['password', 'apiKey'],
    place: ['path', 'unc'],
  }
  for (const g of Object.values(groups)) if (g.includes(fieldKind) && g.includes(bindKind)) return true
  if (fieldKind === 'custom' || fieldKind === 'blob') return true
  return false
}

export interface BlobHit {
  start: number
  end: number
  line: number
  rows: number
  columns: string[]
  reason: string
}

/**
 * Table-shaped blocks: 3+ hashtables with the same key set inside one array
 * (or consecutive [PSCustomObject]@{} literals), or a CSV-shaped here-string.
 */
export function detectTableBlocks(tokens: readonly Token[], text: string): BlobHit[] {
  const hits: BlobHit[] = []

  // here-strings that look like CSV
  for (const tok of tokens) {
    if (tok.kind !== 'string' || (tok.quote !== 'hs-sq' && tok.quote !== 'hs-dq')) continue
    const lines = (tok.logical ?? '').split('\n').filter((l) => l.trim() !== '')
    if (lines.length < 4) continue
    for (const delim of [';', ',', '\t', '|']) {
      const counts = lines.map((l) => l.split(delim).length - 1)
      if (counts[0]! >= 1 && counts.every((c) => c === counts[0])) {
        hits.push({
          start: tok.start,
          end: tok.end,
          line: tok.line,
          rows: lines.length - 1,
          columns: lines[0]!.split(delim).map((c) => c.trim()),
          reason: `CSV-shaped here-string (${delim === '\t' ? 'tab' : delim}-delimited)`,
        })
        break
      }
    }
  }

  // hashtable groups
  interface HT {
    open: number
    close: number
    keys: string[]
    parentOpen: number | null
    startIdx: number
    endIdx: number
  }
  const stack: Array<{ idx: number; raw: string; keys: string[] }> = []
  const tables: HT[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.kind === 'punct' && (t.raw === '@{' || t.raw === '@(' || t.raw === '{' || t.raw === '(' || t.raw === '$(' || t.raw === '[')) {
      stack.push({ idx: i, raw: t.raw, keys: [] })
      continue
    }
    if (t.kind === 'punct' && (t.raw === '}' || t.raw === ')' || t.raw === ']')) {
      const frame = stack.pop()
      if (frame && frame.raw === '@{') {
        const parent = stack[stack.length - 1]
        tables.push({
          open: tokens[frame.idx]!.start,
          close: t.end,
          keys: frame.keys.map((k) => k.toLowerCase()).sort(),
          parentOpen: parent ? parent.idx : null,
          startIdx: frame.idx,
          endIdx: i,
        })
      }
      continue
    }
    if (t.binding?.kind === 'key') {
      const frame = stack[stack.length - 1]
      if (frame && frame.raw === '@{' && !frame.keys.includes(t.binding.name)) frame.keys.push(t.binding.name)
    }
  }
  // group consecutive tables with the same parent and same keys
  let group: HT[] = []
  const flush = () => {
    if (group.length >= 3 && group[0]!.keys.length >= 2) {
      const first = group[0]!
      const last = group[group.length - 1]!
      let start = first.open
      // include the assignment "$Var = @(" / "[PSCustomObject]" prefix on the same statement
      const parentTok = first.parentOpen !== null ? tokens[first.parentOpen] : undefined
      if (parentTok && parentTok.raw === '@(') start = parentTok.start
      let end = last.close
      if (parentTok && parentTok.raw === '@(') {
        // closing paren of the parent array
        let depth = 0
        for (let i = first.parentOpen!; i < tokens.length; i++) {
          const t = tokens[i]!
          if (t.kind === 'punct' && (t.raw === '@(' || t.raw === '(' || t.raw === '$(')) depth++
          else if (t.kind === 'punct' && t.raw === ')') {
            depth--
            if (depth === 0) {
              end = t.end
              break
            }
          }
        }
      }
      hits.push({
        start,
        end,
        line: lineAt(text, start),
        rows: group.length,
        columns: first.keys,
        reason: `${group.length} records with the same ${first.keys.length} keys`,
      })
    }
    group = []
  }
  for (const t of tables) {
    const prev = group[group.length - 1]
    if (prev && prev.parentOpen === t.parentOpen && sameKeys(prev.keys, t.keys)) group.push(t)
    else {
      flush()
      group = [t]
    }
  }
  flush()
  return hits.sort((a, b) => a.start - b.start)
}

function sameKeys(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i])
}

function lineAt(text: string, offset: number): number {
  let line = 0
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++
  return line
}
