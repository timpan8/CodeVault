import type { CompareMode, Field, FieldKind, Sensitivity } from './types'

export type MatchRule = 'anchor-only' | 'whole-token' | 'substring'

/** One constant set for how short values may be matched (see plan). */
export function matchRuleFor(value: string): MatchRule {
  const len = value.length
  if (len < 4) return 'anchor-only'
  if (len < 8) return 'whole-token'
  return 'substring'
}

export const ALIAS_STOPLIST: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  'server',
  'admin',
  'password',
  'test',
  'user',
  'domain',
  'temp',
  'example',
])

export function defaultCompare(kind: FieldKind): CompareMode {
  switch (kind) {
    case 'username':
    case 'server':
    case 'domain':
    case 'path':
    case 'email':
    case 'unc':
      return 'ci'
    default:
      return 'exact'
  }
}

export function defaultSensitivity(kind: FieldKind, realValue?: string): Sensitivity {
  switch (kind) {
    case 'password':
    case 'apiKey':
    case 'blob':
      return 'secret'
    case 'path':
      return realValue !== undefined ? pathSensitivity(realValue) : 'public'
    default:
      return 'internal'
  }
}

/** Local paths are public unless they carry a UNC host or a user-profile segment. */
export function pathSensitivity(realValue: string): Sensitivity {
  if (realValue.startsWith('\\\\')) return 'internal'
  if (/[\\/]Users[\\/][^\\/]+/i.test(realValue)) return 'internal'
  return 'public'
}

/** Strip $, -, scope prefixes and trailing ':' from a binding name; lower-case. */
export function normalizeAnchorName(raw: string): string {
  let s = raw.trim()
  if (s.startsWith('-')) s = s.slice(1)
  if (s.startsWith('$')) s = s.slice(1)
  if (s.startsWith('{') && s.endsWith('}')) s = s.slice(1, -1)
  s = s.replace(/^(script|global|local|private|using|variable):/i, '')
  if (s.endsWith(':')) s = s.slice(0, -1)
  return s.toLowerCase()
}

/** Characters that would need escaping in some PowerShell quote context. */
export function needsEscapingChars(s: string): boolean {
  return /['"`$\r\n]/.test(s)
}

export type ExampleProblem =
  | 'too-short'
  | 'needs-escaping'
  | 'not-unique'
  | 'substring-of-other'
  | 'contains-other'
  | 'equals-real'

export interface ExampleValidationInput {
  kind: FieldKind
  /** Other fields' examples (excluding the field being validated). */
  otherExamples: readonly string[]
  /** All real values in the vault (decrypted, in memory only). */
  realValues: readonly string[]
}

/**
 * Rules for a canonical example value: >= 6 chars, no chars needing escaping,
 * unique (case-insensitive) in the vault, and (except for paths, where prefix
 * relationships are natural) not a substring of, nor containing, any other
 * example or real value.
 */
export function validateExample(example: string, input: ExampleValidationInput): ExampleProblem[] {
  const problems: ExampleProblem[] = []
  if (example.length < 6) problems.push('too-short')
  const structural = input.kind === 'blob'
  if (!structural && needsEscapingChars(example)) problems.push('needs-escaping')
  const ex = example.toLowerCase()
  for (const other of input.otherExamples) {
    const o = other.toLowerCase()
    if (o === ex) {
      problems.push('not-unique')
      continue
    }
    if (input.kind === 'path' || input.kind === 'unc' || structural) continue
    if (o.includes(ex)) problems.push('substring-of-other')
    else if (ex.includes(o)) problems.push('contains-other')
  }
  for (const real of input.realValues) {
    const r = real.toLowerCase()
    if (r === ex) {
      problems.push('equals-real')
      continue
    }
    if (input.kind === 'path' || input.kind === 'unc' || structural) continue
    if (r.length >= 4 && (r.includes(ex) || ex.includes(r))) problems.push('substring-of-other')
  }
  return [...new Set(problems)]
}

export interface CreateFieldInput {
  id: string
  name: string
  kind: FieldKind
  example: string
  scope?: Field['scope']
  sensitivity?: Sensitivity
  compare?: CompareMode
  nameAnchors?: string[]
  template?: string
  now: string
  realValueForDefaults?: string
}

export function createField(input: CreateFieldInput): Field {
  return {
    id: input.id,
    name: input.name,
    kind: input.kind,
    sensitivity: input.sensitivity ?? defaultSensitivity(input.kind, input.realValueForDefaults),
    scope: input.scope ?? 'global',
    example: input.example,
    aliases: [],
    nameAnchors: (input.nameAnchors ?? []).map(normalizeAnchorName),
    compare: input.compare ?? defaultCompare(input.kind),
    ...(input.template ? { template: input.template } : {}),
    createdAt: input.now,
    updatedAt: input.now,
  }
}

/** Suggest an upper-case field name from a binding name or kind. */
export function suggestFieldName(kind: FieldKind, anchor?: string): string {
  const base = anchor ? normalizeAnchorName(anchor) : ''
  const cleaned = base.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toUpperCase()
  if (cleaned.length >= 3) return cleaned
  const byKind: Record<FieldKind, string> = {
    username: 'USERNAME',
    password: 'PASSWORD',
    server: 'SERVER',
    domain: 'DOMAIN',
    path: 'PATH',
    email: 'EMAIL',
    tenantId: 'TENANT_ID',
    apiKey: 'API_KEY',
    ip: 'IP_ADDRESS',
    unc: 'UNC_PATH',
    blob: 'DATA_BLOCK',
    custom: 'VALUE',
  }
  return byKind[kind]
}
