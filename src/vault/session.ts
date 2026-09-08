/**
 * An unlocked vault: holds the DEK and an in-memory copy of every record.
 * Reads are synchronous; every mutation is persisted (encrypted) before it
 * resolves and bumps the header revision. lock() drops the key and the
 * caches; afterwards every method throws LockedError.
 */
import type { Field, Segment } from '@engine/types'
import { contentHash as hashSegments, escapeValue } from '@engine/template'
import {
  ALTERNATE_NAMESPACES,
  DEFAULT_NAMESPACE,
  generateExample,
  realValueCollidesWithNamespace,
  type ExampleNamespace,
} from '@engine/examples'
import { createField as engineCreateField, normalizeAnchorName, validateExample, type ExampleProblem } from '@engine/fields'
import {
  changePassword as cryptoChangePassword,
  createVault,
  randomId,
  rotateRecoveryKey as cryptoRotateRecoveryKey,
  unlockWithPassword,
  unlockWithRecoveryKey,
  type VaultHeader,
} from './crypto'
import { VaultStore, type DecodedRecord } from './store'
import {
  DEFAULT_SETTINGS,
  splitField,
  type AllowlistRecord,
  type ExclusionRecord,
  type FieldRecord,
  type RecordType,
  type RetiredRecord,
  type ScriptRecord,
  type SettingsRecord,
  type VersionRecord,
} from './model'
import type { MergePlan } from './merge'

export class LockedError extends Error {
  constructor() {
    super('Vault is locked')
    this.name = 'LockedError'
  }
}

export class ExampleInvalidError extends Error {
  constructor(public problems: ExampleProblem[]) {
    super(`Invalid example value: ${problems.join(', ')}`)
    this.name = 'ExampleInvalidError'
  }
}

export interface SessionOptions {
  appVersion?: string
  now?: () => string
}

export interface CreateFieldInput {
  name: string
  kind: Field['kind']
  real?: string
  example?: string
  scope?: Field['scope']
  sensitivity?: Field['sensitivity']
  nameAnchors?: string[]
  template?: string
  aiVisibleName?: string
}

export interface UpdateFieldInput {
  name?: string
  kind?: Field['kind']
  sensitivity?: Field['sensitivity']
  scope?: Field['scope']
  real?: string
  aliases?: Field['aliases']
  nameAnchors?: string[]
  template?: string
  exposedAt?: string | null
}

export interface CreateScriptInput {
  title: string
  aiVisibleName?: string
  language?: ScriptRecord['language']
  eol?: ScriptRecord['eol']
}

export interface AddVersionInput {
  scriptId: string
  segments: Segment[]
  source: VersionRecord['source']
  eol: VersionRecord['eol']
  parentVersionId?: string
  note?: string
  aiPrompt?: string
  tags?: string[]
  reviewLog?: VersionRecord['reviewLog']
  acks?: string[]
  needsReview?: boolean
}

export interface EngineSnapshot {
  /** Fields the script may auto-apply: its own plus global ones. */
  own: Field[]
  /** Fields of other scripts: candidates only. */
  other: Field[]
  /** All fields (non-tombstoned), for the guard. */
  all: Field[]
  real: Map<string, string>
  retired: Array<{ fieldId: string; value: string }>
  allowlist: Array<{ value: string; expiresAt?: string }>
  exclusions: Array<{ fieldId: string; lineFp: string }>
  settings: SettingsRecord
  ns: ExampleNamespace
  orgHostRegex?: RegExp
}

const NAMESPACES: readonly ExampleNamespace[] = [DEFAULT_NAMESPACE, ...ALTERNATE_NAMESPACES]

export class VaultSession {
  private dek: CryptoKey | null
  private _header: VaultHeader
  private scripts = new Map<string, ScriptRecord>()
  private versions = new Map<string, VersionRecord>()
  private fields = new Map<string, FieldRecord>()
  private retired = new Map<string, RetiredRecord>()
  private allowlist = new Map<string, AllowlistRecord>()
  private exclusions = new Map<string, ExclusionRecord>()
  private settings: SettingsRecord = { ...DEFAULT_SETTINGS }
  private listeners = new Set<() => void>()
  changedSinceBackup = false

  private constructor(
    private store: VaultStore,
    header: VaultHeader,
    dek: CryptoKey,
    private opts: SessionOptions,
  ) {
    this._header = header
    this.dek = dek
  }

  static async create(
    store: VaultStore,
    password: string,
    opts: SessionOptions & { iterations?: number; deviceId?: string } = {},
  ): Promise<{ session: VaultSession; recoveryKey: string }> {
    if (await store.exists()) throw new Error('Vault already exists')
    const now = opts.now?.() ?? new Date().toISOString()
    const created = await createVault(password, {
      ...(opts.iterations !== undefined ? { iterations: opts.iterations } : {}),
      appVersion: opts.appVersion ?? '0.0.0',
      ...(opts.deviceId ? { deviceId: opts.deviceId } : {}),
      now,
    })
    await store.writeHeader(created.header)
    const session = new VaultSession(store, created.header, created.dek, opts)
    await session.persist('settings', 'settings', { ...DEFAULT_SETTINGS, updatedAt: now })
    return { session, recoveryKey: created.recoveryKey }
  }

  static async open(
    store: VaultStore,
    secret: { password: string } | { recoveryKey: string },
    opts: SessionOptions = {},
  ): Promise<VaultSession> {
    const header = await store.header()
    if (!header) throw new Error('No vault')
    if (header.formatVersion > 1) throw new Error(`Vault format ${header.formatVersion} needs a newer app version`)
    const dek = 'password' in secret ? await unlockWithPassword(header, secret.password) : await unlockWithRecoveryKey(header, secret.recoveryKey)
    const session = new VaultSession(store, header, dek, opts)
    await session.loadAll()
    return session
  }

  private async loadAll(): Promise<void> {
    const dek = this.key()
    const load = async <T>(type: RecordType) => this.store.listRecords<T>(dek, type)
    for (const r of await load<ScriptRecord>('script')) this.scripts.set(r.id, r.data)
    for (const r of await load<VersionRecord>('version')) this.versions.set(r.id, r.data)
    for (const r of await load<FieldRecord>('field')) this.fields.set(r.id, r.data)
    for (const r of await load<RetiredRecord>('retired')) this.retired.set(r.id, r.data)
    for (const r of await load<AllowlistRecord>('allowlist')) this.allowlist.set(r.id, r.data)
    for (const r of await load<ExclusionRecord>('exclusion')) this.exclusions.set(r.id, r.data)
    const settings = await this.store.getRecord<SettingsRecord>(dek, 'settings', 'settings')
    if (settings) this.settings = { ...DEFAULT_SETTINGS, ...settings.data }
  }

  // ---- state -------------------------------------------------------------

  get header(): VaultHeader {
    return this._header
  }

  get isLocked(): boolean {
    return this.dek === null
  }

  private key(): CryptoKey {
    if (!this.dek) throw new LockedError()
    return this.dek
  }

  private now(): string {
    return this.opts.now?.() ?? new Date().toISOString()
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private notify(): void {
    for (const fn of this.listeners) fn()
  }

  lock(): void {
    this.dek = null
    this.scripts.clear()
    this.versions.clear()
    this.fields.clear()
    this.retired.clear()
    this.allowlist.clear()
    this.exclusions.clear()
    this.settings = { ...DEFAULT_SETTINGS }
    this.notify()
  }

  namespace(): ExampleNamespace {
    return NAMESPACES[this._header.namespaceIndex] ?? DEFAULT_NAMESPACE
  }

  // ---- persistence -------------------------------------------------------

  private async bumpHeader(patch: Partial<VaultHeader> = {}): Promise<void> {
    this._header = { ...this._header, ...patch, revision: this._header.revision + 1, updatedAt: this.now() }
    await this.store.writeHeader(this._header)
  }

  private async persist<T>(type: RecordType, id: string, data: T, scriptId?: string): Promise<void> {
    const dek = this.key()
    await this.store.putRecord<T>(dek, {
      id,
      type,
      ...(scriptId !== undefined ? { scriptId } : {}),
      updatedAt: this.now(),
      deviceId: this._header.deviceId,
      data,
    })
    await this.bumpHeader()
    this.changedSinceBackup = true
    this.notify()
  }

  private async remove(id: string): Promise<void> {
    this.key()
    await this.store.deleteRecord(id)
    await this.bumpHeader()
    this.changedSinceBackup = true
    this.notify()
  }

  async changePassword(current: { password: string } | { recoveryKey: string }, newPassword: string): Promise<void> {
    this.key()
    const header = await cryptoChangePassword(this._header, current, newPassword, this.now())
    await this.bumpHeader(header)
    this.notify()
  }

  async rotateRecoveryKey(password: string): Promise<string> {
    this.key()
    const { header, recoveryKey } = await cryptoRotateRecoveryKey(this._header, password, this.now())
    await this.bumpHeader(header)
    return recoveryKey
  }

  // ---- scripts -----------------------------------------------------------

  listScripts(): ScriptRecord[] {
    this.key()
    return [...this.scripts.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  getScript(id: string): ScriptRecord | undefined {
    this.key()
    return this.scripts.get(id)
  }

  async createScript(input: CreateScriptInput): Promise<ScriptRecord> {
    const now = this.now()
    const script: ScriptRecord = {
      id: randomId(),
      title: input.title,
      aiVisibleName: input.aiVisibleName ?? 'Project01',
      language: input.language ?? 'powershell',
      eol: input.eol ?? 'crlf',
      createdAt: now,
      updatedAt: now,
    }
    this.scripts.set(script.id, script)
    await this.persist('script', script.id, script, script.id)
    return script
  }

  async updateScript(id: string, patch: Partial<Omit<ScriptRecord, 'id' | 'createdAt'>>): Promise<ScriptRecord> {
    const cur = this.scripts.get(id)
    if (!cur) throw new Error('Unknown script')
    const next: ScriptRecord = { ...cur, ...patch, updatedAt: this.now() }
    this.scripts.set(id, next)
    await this.persist('script', id, next, id)
    return next
  }

  async deleteScript(id: string): Promise<void> {
    if (!this.scripts.has(id)) return
    for (const v of [...this.versions.values()].filter((v) => v.scriptId === id)) {
      this.versions.delete(v.id)
      await this.remove(v.id)
    }
    for (const e of [...this.exclusions.values()].filter((e) => e.scriptId === id)) {
      this.exclusions.delete(e.id)
      await this.remove(e.id)
    }
    for (const f of [...this.fields.values()].filter((f) => f.scope === `script:${id}` && !f.tombstone)) {
      await this.deleteField(f.id, 'soft')
    }
    this.scripts.delete(id)
    await this.remove(id)
  }

  // ---- versions ----------------------------------------------------------

  listVersions(scriptId: string): VersionRecord[] {
    this.key()
    return [...this.versions.values()].filter((v) => v.scriptId === scriptId).sort((a, b) => a.seq - b.seq)
  }

  getVersion(id: string): VersionRecord | undefined {
    this.key()
    return this.versions.get(id)
  }

  latestVersion(scriptId: string): VersionRecord | undefined {
    const all = this.listVersions(scriptId)
    return all[all.length - 1]
  }

  findVersionByHash(scriptId: string, contentHash: string): VersionRecord | undefined {
    return this.listVersions(scriptId).find((v) => v.contentHash === contentHash)
  }

  async addVersion(input: AddVersionInput): Promise<VersionRecord> {
    this.key()
    if (!this.scripts.has(input.scriptId)) throw new Error('Unknown script')
    const now = this.now()
    const seq = this.listVersions(input.scriptId).reduce((m, v) => Math.max(m, v.seq), 0) + 1
    const version: VersionRecord = {
      id: randomId(),
      scriptId: input.scriptId,
      seq,
      ...(input.parentVersionId ? { parentVersionId: input.parentVersionId } : {}),
      createdAt: now,
      source: input.source,
      segments: input.segments,
      contentHash: await hashSegments(input.segments),
      eol: input.eol,
      ...(input.note ? { note: input.note } : {}),
      ...(input.aiPrompt ? { aiPrompt: input.aiPrompt } : {}),
      tags: input.tags ?? [],
      reviewLog: input.reviewLog ?? [],
      acks: input.acks ?? [],
      needsReview: input.needsReview ?? false,
      updatedAt: now,
    }
    this.versions.set(version.id, version)
    await this.persist('version', version.id, version, version.scriptId)
    await this.updateScript(input.scriptId, {})
    return version
  }

  async updateVersion(
    id: string,
    patch: Partial<Pick<VersionRecord, 'segments' | 'note' | 'aiPrompt' | 'tags' | 'reviewLog' | 'acks' | 'needsReview'>>,
  ): Promise<VersionRecord> {
    const cur = this.versions.get(id)
    if (!cur) throw new Error('Unknown version')
    const next: VersionRecord = { ...cur, ...patch, updatedAt: this.now() }
    if (patch.segments) next.contentHash = await hashSegments(patch.segments)
    this.versions.set(id, next)
    await this.persist('version', id, next, next.scriptId)
    return next
  }

  async deleteVersion(id: string): Promise<void> {
    const cur = this.versions.get(id)
    if (!cur) return
    const script = this.scripts.get(cur.scriptId)
    const siblings = this.listVersions(cur.scriptId)
    if (siblings.length <= 1) throw new Error('Cannot delete the only version')
    if (script?.stableVersionId === id) throw new Error('Cannot delete the stable version')
    this.versions.delete(id)
    await this.remove(id)
  }

  // ---- fields ------------------------------------------------------------

  listFields(includeTombstoned = false): FieldRecord[] {
    this.key()
    return [...this.fields.values()].filter((f) => includeTombstoned || !f.tombstone)
  }

  getField(id: string): FieldRecord | undefined {
    this.key()
    return this.fields.get(id)
  }

  realValue(fieldId: string, profile = 'default'): string | undefined {
    const rec = this.fields.get(fieldId)
    return rec ? this.resolvedReal(rec, profile) : undefined
  }

  /** Real value with `{{NAME}}` references to other fields resolved (max depth 3). */
  private resolvedReal(rec: FieldRecord, profile = 'default', depth = 0): string | undefined {
    const own = rec.valueByProfile[profile]
    if (!rec.template || depth > 3) return own
    let ok = true
    const resolved = rec.template.replace(/\{\{([^}]+)\}\}/g, (_, name: string) => {
      const target = [...this.fields.values()].find((f) => f.name.toLowerCase() === name.trim().toLowerCase() && !f.tombstone)
      const v = target ? this.resolvedReal(target, profile, depth + 1) : undefined
      if (v === undefined) ok = false
      return v ?? ''
    })
    return ok ? resolved : own
  }

  findFieldByRealValue(value: string): FieldRecord | undefined {
    const v = value.toLowerCase()
    return this.listFields().find((f) => {
      const r = this.resolvedReal(f)
      return r !== undefined && (f.compare === 'ci' ? r.toLowerCase() === v : r === value)
    })
  }

  private otherExamples(exceptId?: string): string[] {
    return [...this.fields.values()].filter((f) => f.id !== exceptId).map((f) => f.example)
  }

  private allRealValues(exceptId?: string): string[] {
    const out: string[] = []
    for (const f of this.fields.values()) {
      if (f.id === exceptId) continue
      for (const v of Object.values(f.valueByProfile)) if (v) out.push(v)
      const resolved = this.resolvedReal(f)
      if (resolved && !out.includes(resolved)) out.push(resolved)
    }
    return out
  }

  /** Switch to an alternate namespace when a real value would fall inside the current one. */
  private async ensureNamespaceFor(real: string | undefined): Promise<ExampleNamespace> {
    let ns = this.namespace()
    if (!real || !realValueCollidesWithNamespace(real, ns)) return ns
    for (let i = 0; i < NAMESPACES.length; i++) {
      if (i === this._header.namespaceIndex) continue
      const candidate = NAMESPACES[i]!
      if (!realValueCollidesWithNamespace(real, candidate)) {
        await this.bumpHeader({ namespaceIndex: i })
        ns = candidate
        break
      }
    }
    return ns
  }

  async createField(input: CreateFieldInput): Promise<FieldRecord> {
    this.key()
    const ns = await this.ensureNamespaceFor(input.real)
    let example = input.example
    const validation = (ex: string) =>
      validateExample(ex, { kind: input.kind, otherExamples: this.otherExamples(), realValues: this.allRealValues() })
    if (example !== undefined) {
      const problems = validation(example)
      if (problems.length) throw new ExampleInvalidError(problems)
    } else {
      const used = new Set(this.otherExamples().map((e) => e.toLowerCase()))
      for (let n = 1; n < 10_000; n++) {
        const candidate = generateExample(input.kind, n, ns, {
          ...(input.real ? { shapeOf: input.real } : {}),
          ...(input.aiVisibleName ? { aiVisibleName: input.aiVisibleName } : {}),
        })
        if (used.has(candidate.toLowerCase())) continue
        if (validation(candidate).length === 0) {
          example = candidate
          break
        }
      }
      if (example === undefined) throw new Error('Could not generate a unique example value')
    }
    const base = engineCreateField({
      id: randomId(),
      name: input.name,
      kind: input.kind,
      example,
      now: this.now(),
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.sensitivity ? { sensitivity: input.sensitivity } : {}),
      ...(input.nameAnchors ? { nameAnchors: input.nameAnchors } : {}),
      ...(input.template ? { template: input.template } : {}),
      ...(input.real !== undefined ? { realValueForDefaults: input.real } : {}),
    })
    const rec: FieldRecord = { ...base, valueByProfile: input.real !== undefined ? { default: input.real } : {} }
    this.fields.set(rec.id, rec)
    await this.persist('field', rec.id, rec)
    await this.purgeAllowlistFor(input.real)
    return rec
  }

  async updateField(id: string, patch: UpdateFieldInput): Promise<FieldRecord> {
    const cur = this.fields.get(id)
    if (!cur) throw new Error('Unknown field')
    const now = this.now()
    const next: FieldRecord = { ...cur, updatedAt: now }
    if (patch.name !== undefined) next.name = patch.name
    if (patch.kind !== undefined) next.kind = patch.kind
    if (patch.sensitivity !== undefined) next.sensitivity = patch.sensitivity
    if (patch.scope !== undefined) next.scope = patch.scope
    if (patch.aliases !== undefined) next.aliases = patch.aliases
    if (patch.nameAnchors !== undefined) next.nameAnchors = patch.nameAnchors.map(normalizeAnchorName)
    if (patch.template !== undefined) next.template = patch.template
    if (patch.exposedAt === null) delete next.exposedAt
    else if (patch.exposedAt !== undefined) next.exposedAt = patch.exposedAt
    if (patch.real !== undefined && patch.real !== cur.valueByProfile['default']) {
      const old = cur.valueByProfile['default']
      next.valueByProfile = { ...cur.valueByProfile, default: patch.real }
      if (old) {
        next.previousValue = old
        await this.addRetired(id, old)
      }
      await this.ensureNamespaceFor(patch.real)
      delete next.exposedAt
    }
    this.fields.set(id, next)
    await this.persist('field', id, next)
    if (patch.real !== undefined) await this.purgeAllowlistFor(patch.real)
    return next
  }

  /** Where is this field used? */
  fieldUsage(fieldId: string): Array<{ scriptId: string; versionId: string; seq: number; count: number }> {
    this.key()
    const out: Array<{ scriptId: string; versionId: string; seq: number; count: number }> = []
    for (const v of this.versions.values()) {
      const count = v.segments.filter((s) => s.t === 'slot' && s.fieldId === fieldId).length
      if (count > 0) out.push({ scriptId: v.scriptId, versionId: v.id, seq: v.seq, count })
    }
    return out
  }

  /**
   * Soft delete keeps the record (tombstoned) so templates stay renderable.
   * Hard delete rewrites every referencing version to the EXAMPLE value and
   * removes the record. The real value is retired in both cases.
   */
  async deleteField(id: string, mode: 'soft' | 'hard'): Promise<void> {
    const cur = this.fields.get(id)
    if (!cur) return
    const real = cur.valueByProfile['default']
    if (real) await this.addRetired(id, real)
    if (mode === 'soft') {
      const next: FieldRecord = { ...cur, tombstone: true, valueByProfile: {}, updatedAt: this.now() }
      delete next.previousValue
      this.fields.set(id, next)
      await this.persist('field', id, next)
      return
    }
    for (const usage of this.fieldUsage(id)) {
      const v = this.versions.get(usage.versionId)!
      await this.updateVersion(v.id, { segments: materializeField(v.segments, cur) })
    }
    this.fields.delete(id)
    await this.remove(id)
  }

  // ---- retired / allowlist / exclusions ---------------------------------

  listRetired(): RetiredRecord[] {
    this.key()
    return [...this.retired.values()]
  }

  private async addRetired(fieldId: string, value: string): Promise<void> {
    if ([...this.retired.values()].some((r) => r.fieldId === fieldId && r.value === value)) return
    const rec: RetiredRecord = { id: randomId(), fieldId, value, retiredAt: this.now() }
    this.retired.set(rec.id, rec)
    await this.persist('retired', rec.id, rec)
  }

  listAllowlist(): AllowlistRecord[] {
    this.key()
    return [...this.allowlist.values()]
  }

  async addAllowlist(value: string, expiresAt?: string): Promise<AllowlistRecord> {
    const existing = [...this.allowlist.values()].find((a) => a.value.toLowerCase() === value.toLowerCase())
    if (existing) return existing
    const rec: AllowlistRecord = { id: randomId(), value, createdAt: this.now(), ...(expiresAt ? { expiresAt } : {}) }
    this.allowlist.set(rec.id, rec)
    await this.persist('allowlist', rec.id, rec)
    return rec
  }

  async removeAllowlist(id: string): Promise<void> {
    if (!this.allowlist.delete(id)) return
    await this.remove(id)
  }

  /** Creating or changing a field purges allow-list entries that contain its value. */
  private async purgeAllowlistFor(value: string | undefined): Promise<void> {
    if (!value || value.length < 4) return
    const v = value.toLowerCase()
    for (const a of [...this.allowlist.values()]) {
      if (a.value.toLowerCase().includes(v)) await this.removeAllowlist(a.id)
    }
  }

  listExclusions(scriptId?: string): ExclusionRecord[] {
    this.key()
    return [...this.exclusions.values()].filter((e) => scriptId === undefined || e.scriptId === scriptId)
  }

  async addExclusion(scriptId: string, fieldId: string, lineFp: string): Promise<ExclusionRecord> {
    const existing = [...this.exclusions.values()].find((e) => e.scriptId === scriptId && e.fieldId === fieldId && e.lineFp === lineFp)
    if (existing) return existing
    const rec: ExclusionRecord = { id: randomId(), scriptId, fieldId, lineFp, createdAt: this.now() }
    this.exclusions.set(rec.id, rec)
    await this.persist('exclusion', rec.id, rec, scriptId)
    return rec
  }

  // ---- settings ----------------------------------------------------------

  getSettings(): SettingsRecord {
    this.key()
    return this.settings
  }

  async updateSettings(patch: Partial<Omit<SettingsRecord, 'id'>>): Promise<SettingsRecord> {
    this.settings = { ...this.settings, ...patch, id: 'settings', updatedAt: this.now() }
    await this.persist('settings', 'settings', this.settings)
    return this.settings
  }

  // ---- engine snapshot ---------------------------------------------------

  snapshot(scriptId?: string): EngineSnapshot {
    this.key()
    const own: Field[] = []
    const other: Field[] = []
    const all: Field[] = []
    const real = new Map<string, string>()
    for (const rec of this.fields.values()) {
      const { field } = splitField(rec)
      const r = this.resolvedReal(rec)
      if (r !== undefined) real.set(field.id, r)
      if (rec.tombstone) continue
      all.push(field)
      if (field.scope === 'global' || (scriptId !== undefined && field.scope === `script:${scriptId}`)) own.push(field)
      else other.push(field)
    }
    const orgHostRegex = this.settings.orgHostRegex ? safeRegex(this.settings.orgHostRegex) : undefined
    return {
      own,
      other,
      all,
      real,
      retired: [...this.retired.values()].map((r) => ({ fieldId: r.fieldId, value: r.value })),
      allowlist: [...this.allowlist.values()].map((a) => ({ value: a.value, ...(a.expiresAt ? { expiresAt: a.expiresAt } : {}) })),
      exclusions: [...this.exclusions.values()]
        .filter((e) => scriptId === undefined || e.scriptId === scriptId)
        .map((e) => ({ fieldId: e.fieldId, lineFp: e.lineFp })),
      settings: this.settings,
      ns: this.namespace(),
      ...(orgHostRegex ? { orgHostRegex } : {}),
    }
  }

  fieldMap(): Map<string, Field> {
    this.key()
    const m = new Map<string, Field>()
    for (const rec of this.fields.values()) m.set(rec.id, splitField(rec).field)
    return m
  }

  // ---- backup / merge ---------------------------------------------------

  async allDecoded(): Promise<DecodedRecord[]> {
    const dek = this.key()
    const out: DecodedRecord[] = []
    for (const type of ['script', 'version', 'field', 'retired', 'allowlist', 'exclusion', 'settings'] as RecordType[]) {
      out.push(...(await this.store.listRecords(dek, type)))
    }
    return out
  }

  async applyMerge(plan: MergePlan): Promise<void> {
    const dek = this.key()
    const rows = [...plan.adds, ...plan.updates]
    if (rows.length === 0) return
    await this.store.putRecords(dek, rows.map((r) => ({ ...r, deviceId: r.deviceId || this._header.deviceId })))
    await this.bumpHeader()
    this.scripts.clear()
    this.versions.clear()
    this.fields.clear()
    this.retired.clear()
    this.allowlist.clear()
    this.exclusions.clear()
    await this.loadAll()
    this.changedSinceBackup = true
    this.notify()
  }

  counts(): Record<string, number> {
    this.key()
    return {
      script: this.scripts.size,
      version: this.versions.size,
      field: this.fields.size,
      retired: this.retired.size,
      allowlist: this.allowlist.size,
      exclusion: this.exclusions.size,
    }
  }
}

/** Replace every slot of `field` by its (escaped) example text. Never the real value. */
export function materializeField(segments: readonly Segment[], field: Field): Segment[] {
  const out: Segment[] = []
  for (const seg of segments) {
    if (seg.t === 'slot' && seg.fieldId === field.id) {
      const text = escapeValue(field.example, seg.quote, { regex: seg.regex === true })
      const last = out[out.length - 1]
      if (last && last.t === 'text') last.s += text
      else out.push({ t: 'text', s: text })
      continue
    }
    const last = out[out.length - 1]
    if (seg.t === 'text' && last && last.t === 'text') last.s += seg.s
    else out.push(seg.t === 'text' ? { t: 'text', s: seg.s } : { ...seg })
  }
  return out
}

function safeRegex(source: string): RegExp | undefined {
  try {
    return new RegExp(source, 'i')
  } catch {
    return undefined
  }
}
