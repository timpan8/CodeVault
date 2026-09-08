/**
 * Merge a backup (decoded records from another device or an older copy)
 * into the local vault.
 *
 * - versions: union per (scriptId, contentHash); append-only, never overwrite;
 *   colliding sequence numbers are renumbered per script
 * - scripts: last-writer-wins on updatedAt, local stable star is kept
 * - fields: last-writer-wins on updatedAt with a conflict entry whenever the
 *   two sides differ; aliases and name anchors are unioned
 * - retired values, allow-list, exclusions: union
 * - settings: local wins
 *
 * Idempotent: merging the same backup twice produces an empty plan.
 */
import type { DecodedRecord } from './store'
import type { AllowlistRecord, ExclusionRecord, FieldRecord, RetiredRecord, ScriptRecord, VersionRecord } from './model'

export interface MergeConflict {
  fieldId: string
  name: string
  localUpdatedAt: string
  incomingUpdatedAt: string
  differing: string[]
  resolution: 'kept-local' | 'took-incoming'
}

export interface MergePreviewScript {
  scriptId: string
  title: string
  incomingVersions: number
  alreadyPresent: number
  newVersions: number
  isNewScript: boolean
}

export interface MergePlan {
  adds: DecodedRecord[]
  updates: DecodedRecord[]
  conflicts: MergeConflict[]
  preview: MergePreviewScript[]
  summary: {
    scriptsAdded: number
    scriptsUpdated: number
    versionsAdded: number
    fieldsAdded: number
    fieldsUpdated: number
    retiredAdded: number
    allowlistAdded: number
    exclusionsAdded: number
  }
}

function byType<T>(records: readonly DecodedRecord[], type: string): DecodedRecord<T>[] {
  return records.filter((r) => r.type === type) as DecodedRecord<T>[]
}

function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']'
  const o = v as Record<string, unknown>
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stableJson(o[k])).join(',') + '}'
}

export function planMerge(local: readonly DecodedRecord[], incoming: readonly DecodedRecord[]): MergePlan {
  const adds: DecodedRecord[] = []
  const updates: DecodedRecord[] = []
  const conflicts: MergeConflict[] = []
  const summary: MergePlan['summary'] = {
    scriptsAdded: 0,
    scriptsUpdated: 0,
    versionsAdded: 0,
    fieldsAdded: 0,
    fieldsUpdated: 0,
    retiredAdded: 0,
    allowlistAdded: 0,
    exclusionsAdded: 0,
  }

  // scripts
  const localScripts = new Map(byType<ScriptRecord>(local, 'script').map((r) => [r.id, r]))
  const incomingScripts = byType<ScriptRecord>(incoming, 'script')
  const scriptTitles = new Map<string, string>()
  const newScriptIds = new Set<string>()
  for (const inc of incomingScripts) {
    scriptTitles.set(inc.id, inc.data.title)
    const loc = localScripts.get(inc.id)
    if (!loc) {
      adds.push(inc)
      newScriptIds.add(inc.id)
      summary.scriptsAdded++
      continue
    }
    scriptTitles.set(inc.id, loc.data.title)
    if (inc.data.updatedAt > loc.data.updatedAt && stableJson(inc.data) !== stableJson(loc.data)) {
      const merged: ScriptRecord = {
        ...inc.data,
        ...(loc.data.stableVersionId ? { stableVersionId: loc.data.stableVersionId } : {}),
      }
      updates.push({ ...inc, data: merged })
      summary.scriptsUpdated++
    }
  }

  // versions
  const localVersions = byType<VersionRecord>(local, 'version')
  const localVersionIds = new Set(localVersions.map((v) => v.id))
  const localHashes = new Set(localVersions.map((v) => `${v.data.scriptId}|${v.data.contentHash}`))
  const maxSeq = new Map<string, number>()
  const usedSeq = new Map<string, Set<number>>()
  for (const v of localVersions) {
    maxSeq.set(v.data.scriptId, Math.max(maxSeq.get(v.data.scriptId) ?? 0, v.data.seq))
    if (!usedSeq.has(v.data.scriptId)) usedSeq.set(v.data.scriptId, new Set())
    usedSeq.get(v.data.scriptId)!.add(v.data.seq)
  }
  const perScript = new Map<string, { incoming: number; present: number; added: number }>()
  const incomingVersions = byType<VersionRecord>(incoming, 'version').sort((a, b) => a.data.seq - b.data.seq)
  for (const inc of incomingVersions) {
    const sid = inc.data.scriptId
    const stat = perScript.get(sid) ?? { incoming: 0, present: 0, added: 0 }
    stat.incoming++
    const key = `${sid}|${inc.data.contentHash}`
    if (localVersionIds.has(inc.id) || localHashes.has(key)) {
      stat.present++
      perScript.set(sid, stat)
      continue
    }
    let seq = inc.data.seq
    const used = usedSeq.get(sid) ?? new Set<number>()
    if (used.has(seq)) {
      seq = (maxSeq.get(sid) ?? 0) + 1
    }
    used.add(seq)
    usedSeq.set(sid, used)
    maxSeq.set(sid, Math.max(maxSeq.get(sid) ?? 0, seq))
    localHashes.add(key)
    adds.push({ ...inc, data: { ...inc.data, seq } })
    summary.versionsAdded++
    stat.added++
    perScript.set(sid, stat)
  }

  // fields
  const localFields = new Map(byType<FieldRecord>(local, 'field').map((r) => [r.id, r]))
  for (const inc of byType<FieldRecord>(incoming, 'field')) {
    const loc = localFields.get(inc.id)
    if (!loc) {
      adds.push(inc)
      summary.fieldsAdded++
      continue
    }
    if (stableJson(inc.data) === stableJson(loc.data)) continue
    const locObj = loc.data as unknown as Record<string, unknown>
    const incObj = inc.data as unknown as Record<string, unknown>
    const differing = Object.keys({ ...locObj, ...incObj }).filter((k) => stableJson(locObj[k]) !== stableJson(incObj[k]))
    const aliases = unionBy([...loc.data.aliases, ...inc.data.aliases], (a) => a.value.toLowerCase())
    const nameAnchors = [...new Set([...loc.data.nameAnchors, ...inc.data.nameAnchors])]
    const incomingNewer = inc.data.updatedAt > loc.data.updatedAt
    if (incomingNewer) {
      updates.push({ ...inc, data: { ...inc.data, aliases, nameAnchors } })
      summary.fieldsUpdated++
    } else if (aliases.length !== loc.data.aliases.length || nameAnchors.length !== loc.data.nameAnchors.length) {
      updates.push({ ...loc, data: { ...loc.data, aliases, nameAnchors } })
      summary.fieldsUpdated++
    }
    const material = differing.filter((k) => k !== 'updatedAt' && k !== 'aliases' && k !== 'nameAnchors')
    if (material.length > 0) {
      conflicts.push({
        fieldId: inc.id,
        name: loc.data.name,
        localUpdatedAt: loc.data.updatedAt,
        incomingUpdatedAt: inc.data.updatedAt,
        differing: material,
        resolution: incomingNewer ? 'took-incoming' : 'kept-local',
      })
    }
  }

  // unions
  const localRetired = new Set(byType<RetiredRecord>(local, 'retired').map((r) => `${r.data.fieldId}|${r.data.value}`))
  for (const inc of byType<RetiredRecord>(incoming, 'retired')) {
    const key = `${inc.data.fieldId}|${inc.data.value}`
    if (localRetired.has(key)) continue
    localRetired.add(key)
    adds.push(inc)
    summary.retiredAdded++
  }
  const localAllow = new Set(byType<AllowlistRecord>(local, 'allowlist').map((r) => r.data.value.toLowerCase()))
  for (const inc of byType<AllowlistRecord>(incoming, 'allowlist')) {
    const key = inc.data.value.toLowerCase()
    if (localAllow.has(key)) continue
    localAllow.add(key)
    adds.push(inc)
    summary.allowlistAdded++
  }
  const localExcl = new Set(byType<ExclusionRecord>(local, 'exclusion').map((r) => `${r.data.scriptId}|${r.data.fieldId}|${r.data.lineFp}`))
  for (const inc of byType<ExclusionRecord>(incoming, 'exclusion')) {
    const key = `${inc.data.scriptId}|${inc.data.fieldId}|${inc.data.lineFp}`
    if (localExcl.has(key)) continue
    localExcl.add(key)
    adds.push(inc)
    summary.exclusionsAdded++
  }

  const preview: MergePreviewScript[] = [...perScript.entries()].map(([scriptId, s]) => ({
    scriptId,
    title: scriptTitles.get(scriptId) ?? scriptId,
    incomingVersions: s.incoming,
    alreadyPresent: s.present,
    newVersions: s.added,
    isNewScript: newScriptIds.has(scriptId),
  }))
  for (const id of newScriptIds) {
    if (!perScript.has(id)) preview.push({ scriptId: id, title: scriptTitles.get(id) ?? id, incomingVersions: 0, alreadyPresent: 0, newVersions: 0, isNewScript: true })
  }

  return { adds, updates, conflicts, preview, summary }
}

function unionBy<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const it of items) {
    const k = key(it)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(it)
  }
  return out
}

export function planIsEmpty(plan: MergePlan): boolean {
  return plan.adds.length === 0 && plan.updates.length === 0
}
