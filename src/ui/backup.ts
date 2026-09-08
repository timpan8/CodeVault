/**
 * Backup plumbing for the UI: directory handle persisted in the store's
 * clear-text meta, rotating encrypted backups plus a structure export on
 * lock and on demand, download fallback when the File System Access API is
 * unavailable.
 */
import { backupFilename, buildBackup, buildStructureExport, serializeBackup, structureExportStrings, structureFilename, writeRotatingFile } from '@vault/backup'
import { guardShortText } from '@engine/guard'
import type { VaultSession } from '@vault/session'
import { store, toast } from './state'
import { downloadText } from './format'
import { t } from '@i18n/index'

const META_KEY = 'backupDirHandle'
const KEEP = 10

type DirHandle = FileSystemDirectoryHandle & {
  queryPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>
}

export function fsAccessSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}

export async function getBackupDir(): Promise<DirHandle | undefined> {
  return store.getMeta<DirHandle>(META_KEY)
}

export async function chooseBackupDir(): Promise<DirHandle | undefined> {
  if (!fsAccessSupported()) return undefined
  const picker = (window as unknown as { showDirectoryPicker: (o: { mode: 'readwrite' }) => Promise<DirHandle> }).showDirectoryPicker
  const handle = await picker({ mode: 'readwrite' })
  await store.setMeta(META_KEY, handle)
  return handle
}

/** Must be called from a user gesture (the unlock click) to re-grant access. */
export async function ensureBackupPermission(): Promise<boolean> {
  const handle = await getBackupDir()
  if (!handle) return false
  try {
    const q = (await handle.queryPermission?.({ mode: 'readwrite' })) ?? 'granted'
    if (q === 'granted') return true
    const r = await handle.requestPermission?.({ mode: 'readwrite' })
    return r === 'granted'
  } catch {
    return false
  }
}

export interface BackupOutcome {
  ok: boolean
  name: string
  where: 'folder' | 'download' | 'skipped'
  structureBlocked?: number
}

export async function writeBackupNow(session: VaultSession, opts: { allowDownload: boolean }): Promise<BackupOutcome> {
  const now = new Date()
  const name = backupFilename(now)
  const backup = serializeBackup(buildBackup(session.header, await store.allRaw(), now.toISOString()))
  const structure = buildStructureExport(
    {
      header: session.header,
      scripts: session.listScripts(),
      versions: session.listScripts().flatMap((s) => session.listVersions(s.id)),
      fields: session.listFields(true),
    },
    now.toISOString(),
  )
  const snap = session.snapshot()
  const blocked = structureExportStrings(structure).filter((s) => guardShortText(s, { fields: snap.all, real: snap.real, retired: snap.retired, allowlist: snap.allowlist }).blocked).length
  const structureText = JSON.stringify(structure, null, 1)

  const dir = await getBackupDir()
  if (dir) {
    try {
      const q = (await dir.queryPermission?.({ mode: 'readwrite' })) ?? 'granted'
      if (q === 'granted') {
        await writeRotatingFile(dir, name, backup, /^codevault-\d{8}-\d{4}\.enc$/, KEEP)
        if (blocked === 0) await writeRotatingFile(dir, structureFilename(now), structureText, /^codevault-\d{8}-\d{4}\.structure\.json$/, KEEP)
        session.changedSinceBackup = false
        await session.updateSettings({ lastBackupAt: now.toISOString() })
        return { ok: true, name, where: 'folder', structureBlocked: blocked }
      }
    } catch (e) {
      toast(t('common.error', { message: e instanceof Error ? e.message : String(e) }), 'error')
    }
  }
  if (!opts.allowDownload) return { ok: false, name, where: 'skipped', structureBlocked: blocked }
  downloadText(name, backup, 'application/json')
  if (blocked === 0) downloadText(structureFilename(now), structureText, 'application/json')
  session.changedSinceBackup = false
  await session.updateSettings({ lastBackupAt: now.toISOString() })
  return { ok: true, name, where: 'download', structureBlocked: blocked }
}
