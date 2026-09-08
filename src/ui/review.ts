/**
 * Review-sheet model: rows derived from a re-apply result plus the user's
 * decisions, and the version that results from them. Pure and testable.
 */
import { applyProposals, type MissingField, type ReapplyResult, type SlotProposal, type UnknownValue } from '@engine/reapply'
import type { Field, Segment } from '@engine/types'
import type { ReviewLogEntry } from '@vault/model'

export type Decision = 'pending' | 'accept' | 'reject' | 'safe'

const FILE_TAIL_RE = /[\\/][^\\/]*\.[A-Za-z0-9]{1,5}$/

/** Directory part of a path literal: strips a trailing file name and trailing separators. */
export function directoryPart(literal: string): string {
  let s = literal
  if (FILE_TAIL_RE.test(s)) s = s.replace(FILE_TAIL_RE, '')
  return s.replace(/[\\/]+$/, '')
}

/**
 * A path field covers the directory prefix only, so the AI's file name after
 * it is kept as text. Shrinks the row span accordingly.
 */
export function trimPathRow(row: ReviewRow): ReviewRow {
  const p = row.proposal
  const u = row.unknown
  const literal = p?.literal ?? u?.literal
  if (!literal) return row
  const dir = directoryPart(literal)
  if (dir.length === 0 || dir.length >= literal.length) return row
  const cut = literal.length - dir.length
  if (p) return { ...row, proposal: { ...p, end: p.end - cut, literal: dir, suffix: literal.slice(dir.length) } }
  if (u) return { ...row, unknown: { ...u, end: u.end - cut, literal: dir } }
  return row
}

export interface ReviewRow {
  id: string
  kind: 'slot' | 'unknown'
  proposal?: SlotProposal
  unknown?: UnknownValue
  decision: Decision
  /** Field this row resolves to (set by auto/confirm rows, or by create/link). */
  fieldId: string | null
  /** Row was rejected with "not a secret here": an exclusion is recorded. */
  excluded?: boolean
  /** Field created or linked by the user in this review. */
  userLinked?: boolean
}

export function initialRows(result: ReapplyResult): ReviewRow[] {
  const rows: ReviewRow[] = []
  result.slots.forEach((p, i) => {
    rows.push({
      id: `s${i}`,
      kind: 'slot',
      proposal: p,
      decision: p.status === 'auto' ? 'accept' : 'pending',
      fieldId: p.status === 'candidate' && p.fromOtherScript ? null : p.fieldId,
    })
  })
  result.unknown.forEach((u, i) => {
    rows.push({ id: `u${i}`, kind: 'unknown', unknown: u, decision: 'pending', fieldId: null })
  })
  return rows
}

export function groupRows(rows: ReviewRow[]) {
  const auto = rows.filter((r) => r.kind === 'slot' && r.proposal!.status === 'auto')
  const confirm = rows.filter((r) => r.kind === 'slot' && r.proposal!.status === 'confirm')
  const candidate = rows.filter((r) => r.kind === 'slot' && r.proposal!.status === 'candidate')
  const unknown = rows.filter((r) => r.kind === 'unknown')
  return { auto, confirm, candidate, unknown }
}

export interface BuiltVersion {
  segments: Segment[]
  needsReview: boolean
  unresolved: number
  reviewLog: ReviewLogEntry[]
  /** Accepted proposals with a field, for learning aliases/anchors. */
  accepted: Array<{ proposal: SlotProposal; fieldId: string }>
  exposedFieldIds: string[]
}

function isSecret(f: Field | undefined): boolean {
  return f !== undefined && (f.kind === 'password' || f.kind === 'apiKey' || f.kind === 'blob')
}

export function buildVersion(
  text: string,
  rows: ReviewRow[],
  missing: MissingField[],
  missingAck: ReadonlySet<string>,
  fields: ReadonlyMap<string, Field>,
  now: string,
): BuiltVersion {
  const proposals: SlotProposal[] = []
  const accepted: BuiltVersion['accepted'] = []
  const reviewLog: ReviewLogEntry[] = []
  const exposed = new Set<string>()
  let unresolved = 0
  let secretUnresolved = 0
  for (const row of rows) {
    if (row.kind === 'unknown') {
      const u = row.unknown!
      if (row.decision === 'pending') {
        unresolved++
        reviewLog.push({ fieldId: null, status: 'unknown', lines: [u.line], method: u.reasons.join(','), at: now })
        continue
      }
      if (row.decision === 'accept' && row.fieldId) {
        // The user registered or linked the real value: it becomes a resolved slot.
        const proposal: SlotProposal = {
          start: u.start,
          end: u.end,
          line: u.line,
          fieldId: row.fieldId,
          quote: u.quote,
          ...(u.regex ? { regex: true } : {}),
          conf: 1,
          status: 'auto',
          why: 'real',
          literal: u.literal,
          ...(u.bindingName ? { bindingName: u.bindingName } : {}),
          warnings: [],
        }
        proposals.push(proposal)
        accepted.push({ proposal, fieldId: row.fieldId })
        reviewLog.push({ fieldId: row.fieldId, status: 'applied', lines: [u.line], method: 'registered', acknowledgedBy: 'user', at: now })
      }
      continue
    }
    const p = row.proposal!
    if (row.decision === 'reject') {
      reviewLog.push({ fieldId: p.fieldId, status: 'ambiguous', lines: [p.line], method: `rejected:${p.why}`, acknowledgedBy: 'user', at: now })
      continue
    }
    if (row.fieldId === null) {
      // candidate without a field: stays plain text
      continue
    }
    const status = row.decision === 'accept' ? 'auto' : 'confirm'
    if (status === 'confirm') {
      unresolved++
      if (isSecret(fields.get(row.fieldId))) secretUnresolved++
    }
    const proposal: SlotProposal = { ...p, fieldId: row.fieldId, status }
    proposals.push(proposal)
    if (row.decision === 'accept') accepted.push({ proposal, fieldId: row.fieldId })
    if (p.exposed) exposed.add(row.fieldId)
    reviewLog.push({
      fieldId: row.fieldId,
      status: status === 'auto' ? 'applied' : 'confirm',
      lines: [p.line],
      method: [p.why, ...p.warnings].join('+'),
      ...(row.decision === 'accept' && p.status !== 'auto' ? { acknowledgedBy: 'user' as const } : {}),
      at: now,
    })
  }
  let missingUnacked = 0
  for (const m of missing) {
    const resolvedByLink = rows.some((r) => r.fieldId === m.fieldId && r.decision === 'accept')
    if (resolvedByLink) continue
    const acked = missingAck.has(m.fieldId)
    if (!acked) missingUnacked++
    reviewLog.push({ fieldId: m.fieldId, status: 'missing', lines: m.prevLines, method: 'missing', ...(acked ? { acknowledgedBy: 'user' as const } : {}), at: now })
  }
  const segments = applyProposals(text, proposals)
  const needsReview = secretUnresolved > 0 || missingUnacked > 0 || rows.some((r) => r.kind === 'unknown' && r.decision === 'pending')
  return { segments, needsReview, unresolved: unresolved + missingUnacked, reviewLog, accepted, exposedFieldIds: [...exposed] }
}
