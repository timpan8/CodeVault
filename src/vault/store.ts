/**
 * Encrypted IndexedDB store (Dexie). Only the vault header is stored in the
 * clear; every record is AES-GCM ciphertext with AAD = type:id. The clear
 * columns `type`, `scriptId`, `updatedAt`, `deviceId` are opaque ids and
 * timestamps needed for indexing and merge.
 */
import Dexie, { type Table } from 'dexie'
import { decryptRecord, encryptRecord, type VaultHeader } from './crypto'
import type { RecordType } from './model'

export interface RawRecord {
  id: string
  type: RecordType
  scriptId: string
  updatedAt: string
  deviceId: string
  payload: string
}

interface MetaRow {
  key: string
  value: unknown
}

class VaultDb extends Dexie {
  records!: Table<RawRecord, string>
  meta!: Table<MetaRow, string>

  constructor(name: string) {
    super(name)
    this.version(1).stores({
      records: 'id, type, scriptId, updatedAt, [type+scriptId]',
      meta: 'key',
    })
  }
}

export interface DecodedRecord<T = unknown> {
  id: string
  type: RecordType
  scriptId: string
  updatedAt: string
  deviceId: string
  data: T
}

export class VaultStore {
  private db: VaultDb

  constructor(name = 'codevault') {
    this.db = new VaultDb(name)
  }

  async header(): Promise<VaultHeader | undefined> {
    const row = await this.db.meta.get('header')
    return row?.value as VaultHeader | undefined
  }

  async writeHeader(header: VaultHeader): Promise<void> {
    await this.db.meta.put({ key: 'header', value: header })
  }

  async exists(): Promise<boolean> {
    return (await this.header()) !== undefined
  }

  /** Small clear-text settings that must be readable while locked (e.g. a directory handle). */
  async getMeta<T>(key: string): Promise<T | undefined> {
    const row = await this.db.meta.get(key)
    return row?.value as T | undefined
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await this.db.meta.put({ key, value })
  }

  async putRecord<T>(dek: CryptoKey, rec: Omit<DecodedRecord<T>, 'scriptId'> & { scriptId?: string }): Promise<void> {
    const payload = await encryptRecord(dek, JSON.stringify(rec.data), `${rec.type}:${rec.id}`)
    await this.db.records.put({
      id: rec.id,
      type: rec.type,
      scriptId: rec.scriptId ?? '',
      updatedAt: rec.updatedAt,
      deviceId: rec.deviceId,
      payload,
    })
  }

  async putRecords<T>(dek: CryptoKey, recs: Array<Omit<DecodedRecord<T>, 'scriptId'> & { scriptId?: string }>): Promise<void> {
    const rows: RawRecord[] = []
    for (const rec of recs) {
      rows.push({
        id: rec.id,
        type: rec.type,
        scriptId: rec.scriptId ?? '',
        updatedAt: rec.updatedAt,
        deviceId: rec.deviceId,
        payload: await encryptRecord(dek, JSON.stringify(rec.data), `${rec.type}:${rec.id}`),
      })
    }
    await this.db.transaction('rw', this.db.records, async () => {
      await this.db.records.bulkPut(rows)
    })
  }

  async getRecord<T>(dek: CryptoKey, type: RecordType, id: string): Promise<DecodedRecord<T> | undefined> {
    const row = await this.db.records.get(id)
    if (!row || row.type !== type) return undefined
    return this.decode<T>(dek, row)
  }

  async listRecords<T>(dek: CryptoKey, type: RecordType, scriptId?: string): Promise<DecodedRecord<T>[]> {
    const rows =
      scriptId === undefined
        ? await this.db.records.where('type').equals(type).toArray()
        : await this.db.records.where('[type+scriptId]').equals([type, scriptId]).toArray()
    const out: DecodedRecord<T>[] = []
    for (const row of rows) out.push(await this.decode<T>(dek, row))
    return out
  }

  async deleteRecord(id: string): Promise<void> {
    await this.db.records.delete(id)
  }

  async deleteRecords(ids: string[]): Promise<void> {
    await this.db.records.bulkDelete(ids)
  }

  async allRaw(): Promise<RawRecord[]> {
    return this.db.records.toArray()
  }

  async countByType(): Promise<Record<string, number>> {
    const out: Record<string, number> = {}
    await this.db.records.each((r) => {
      out[r.type] = (out[r.type] ?? 0) + 1
    })
    return out
  }

  /** Replace everything (used by restore). */
  async replaceAll(header: VaultHeader, rows: RawRecord[]): Promise<void> {
    await this.db.transaction('rw', this.db.records, this.db.meta, async () => {
      await this.db.records.clear()
      await this.db.records.bulkPut(rows)
      await this.db.meta.put({ key: 'header', value: header })
    })
  }

  async clear(): Promise<void> {
    await this.db.transaction('rw', this.db.records, this.db.meta, async () => {
      await this.db.records.clear()
      await this.db.meta.clear()
    })
  }

  async close(): Promise<void> {
    this.db.close()
  }

  async destroy(): Promise<void> {
    await this.db.delete()
  }

  private async decode<T>(dek: CryptoKey, row: RawRecord): Promise<DecodedRecord<T>> {
    const json = await decryptRecord(dek, row.payload, `${row.type}:${row.id}`)
    return { id: row.id, type: row.type, scriptId: row.scriptId, updatedAt: row.updatedAt, deviceId: row.deviceId, data: JSON.parse(json) as T }
  }
}
