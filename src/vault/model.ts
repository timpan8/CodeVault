/**
 * Domain records stored (encrypted) in the vault. The engine's Field type
 * never carries a real value; FieldRecord adds it here, and the session
 * splits the two apart before anything reaches the engine.
 */
import type { Eol, Field, Segment, SlotStatus } from '@engine/types'

export type RecordType = 'script' | 'version' | 'field' | 'retired' | 'allowlist' | 'exclusion' | 'settings'

export interface ScriptRecord {
  id: string
  title: string
  /** Name the AI sees in path examples (default 'Project01'). */
  aiVisibleName: string
  language: 'powershell' | 'plain'
  eol: Eol
  stableVersionId?: string
  createdAt: string
  updatedAt: string
  lastCopiedForAiAt?: string
  lastCopiedRealAt?: string
}

export interface ReviewLogEntry {
  fieldId: string | null
  status: SlotStatus | 'applied' | 'moved' | 'new' | 'ambiguous'
  lines: number[]
  method: string
  acknowledgedBy?: 'user'
  at: string
}

export interface VersionRecord {
  id: string
  scriptId: string
  seq: number
  parentVersionId?: string
  createdAt: string
  source: 'ai' | 'editor' | 'restore' | 'patch'
  segments: Segment[]
  contentHash: string
  eol: Eol
  note?: string
  aiPrompt?: string
  tags: string[]
  reviewLog: ReviewLogEntry[]
  /** Explicit user acknowledgements, e.g. "ADMIN_PW intentionally removed". */
  acks: string[]
  /** True while any secret-kind field is unresolved; blocks "copy real". */
  needsReview: boolean
  updatedAt: string
}

export interface FieldRecord extends Field {
  /** Real values per profile; MVP uses the implicit 'default' profile only. */
  valueByProfile: Record<string, string>
  previousValue?: string
}

export interface RetiredRecord {
  id: string
  fieldId: string
  value: string
  retiredAt: string
}

export interface AllowlistRecord {
  id: string
  value: string
  createdAt: string
  expiresAt?: string
}

export interface ExclusionRecord {
  id: string
  scriptId: string
  fieldId: string
  lineFp: string
  createdAt: string
}

export interface SettingsRecord {
  id: 'settings'
  locale: 'sv' | 'en'
  lockTimeoutMinutes: number
  hiddenTabLockMinutes: number
  /** Global root folder for project folders, e.g. C:\Temp. */
  rootPath?: string
  hideAllPathsFromAi: boolean
  orgHostRegex?: string
  /** Lazy setup steps completed. */
  setupDone: string[]
  /** Prepend the "keep placeholders as-is" line to AI copies. */
  preambleForAi: boolean
  lastBackupAt?: string
  lastBackupVerifiedAt?: string
  updatedAt: string
}

export const DEFAULT_SETTINGS: SettingsRecord = {
  id: 'settings',
  locale: 'sv',
  lockTimeoutMinutes: 10,
  hiddenTabLockMinutes: 2,
  hideAllPathsFromAi: false,
  setupDone: [],
  preambleForAi: true,
  updatedAt: '1970-01-01T00:00:00.000Z',
}

export type AnyRecord =
  | { type: 'script'; data: ScriptRecord }
  | { type: 'version'; data: VersionRecord }
  | { type: 'field'; data: FieldRecord }
  | { type: 'retired'; data: RetiredRecord }
  | { type: 'allowlist'; data: AllowlistRecord }
  | { type: 'exclusion'; data: ExclusionRecord }
  | { type: 'settings'; data: SettingsRecord }

/** Split a FieldRecord into the engine-facing Field and its real value. */
export function splitField(rec: FieldRecord, profile = 'default'): { field: Field; real: string | undefined } {
  const { valueByProfile, previousValue: _prev, ...field } = rec
  return { field, real: valueByProfile[profile] }
}
