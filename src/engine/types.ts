/**
 * Core engine types. The engine never sees decrypted real values inside a
 * Field: real values travel separately as a `ReadonlyMap<fieldId, string>`
 * and only when a caller explicitly needs them (render 'real', guard, reapply).
 */

export type FieldKind =
  | 'username'
  | 'password'
  | 'server'
  | 'domain'
  | 'path'
  | 'email'
  | 'tenantId'
  | 'apiKey'
  | 'ip'
  | 'unc'
  | 'blob'
  | 'custom'

export const FIELD_KINDS: readonly FieldKind[] = [
  'username',
  'password',
  'server',
  'domain',
  'path',
  'email',
  'tenantId',
  'apiKey',
  'ip',
  'unc',
  'blob',
  'custom',
]

export type Sensitivity = 'secret' | 'internal' | 'public'
export type CompareMode = 'exact' | 'ci'

/** Syntactic context of a slot: decides how a value is escaped on render. */
export type QuoteKind = 'sq' | 'dq' | 'hs-sq' | 'hs-dq' | 'bare' | 'comment'

export type SlotStatus = 'auto' | 'confirm' | 'candidate' | 'missing' | 'unknown'
export type Eol = 'crlf' | 'lf'

export interface FieldAlias {
  value: string
  /** Only matches together with a name anchor and is always 'confirm'. */
  anchorOnly: boolean
}

export interface Field {
  id: string
  name: string
  kind: FieldKind
  sensitivity: Sensitivity
  scope: 'global' | `script:${string}`
  /** Canonical example value. Immutable once the AI has seen it. */
  example: string
  aliases: FieldAlias[]
  /** Normalised binding names ($Var, -Param, hashtable key) seen for this field. */
  nameAnchors: string[]
  compare: CompareMode
  /** Derived value template, e.g. '{{Root}}\\{{Slug}}'. */
  template?: string
  exposedAt?: string
  tombstone?: boolean
  createdAt: string
  updatedAt: string
}

export type Segment =
  | { t: 'text'; s: string }
  | {
      t: 'slot'
      fieldId: string
      quote: QuoteKind
      conf: number
      status: SlotStatus
      /** Value sits in a regex operand: regex-escape before quote-escaping. */
      regex?: boolean
    }

export interface TemplateContext {
  fields: ReadonlyMap<string, Field>
  /** Decrypted real values; only needed for mode 'real'. */
  real?: ReadonlyMap<string, string>
  eol?: Eol
  /** Plain-text mode: literal replacement, no PowerShell escaping. */
  plain?: boolean
}
