import { useState } from 'preact/hooks'
import { compareOrigin, openBackup, parseBackup, restoreIntoStore, testRestore, type BackupFile } from '@vault/backup'
import { planIsEmpty, planMerge, type MergePlan } from '@vault/merge'
import { VaultSession } from '@vault/session'
import { WrongPasswordError, formatRecoveryKey } from '@vault/crypto'
import type { FieldKind } from '@engine/types'
import { APP_VERSION, getSession, setSession, startAutoLock, store, toast, useTick } from '../state'
import { chooseBackupDir, fsAccessSupported, getBackupDir, writeBackupNow } from '../backup'
import { SecretInput } from '../components/SecretInput'
import { Modal } from '../components/Modal'
import { kindLabel, shortDate } from '../format'
import { setLocale, t } from '@i18n/index'

export function Settings() {
  useTick()
  const session = getSession()
  const settings = session.getSettings()
  return (
    <div class="cv-page cv-settings">
      <h2>{t('settings.title')}</h2>
      <BackupSection />
      <ImportSection />
      <SecuritySection />
      <OrgSection />
      <GeneralSection />
      <FieldsSection />
      <p class="cv-muted cv-small">
        {t('about.version', { v: APP_VERSION })} · {t('settings.retired', { n: session.listRetired().length })} · locale {settings.locale}
      </p>
    </div>
  )
}

function BackupSection() {
  const session = getSession()
  const settings = session.getSettings()
  const [dirName, setDirName] = useState<string | null>(null)
  const [checked, setChecked] = useState(false)
  if (!checked) {
    setChecked(true)
    void getBackupDir().then((h) => setDirName(h?.name ?? null))
  }
  const choose = async () => {
    try {
      const h = await chooseBackupDir()
      setDirName(h?.name ?? null)
      if (h) await session.updateSettings({ setupDone: [...new Set([...settings.setupDone, 'backupFolder'])] })
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) toast(t('common.error', { message: e instanceof Error ? e.message : String(e) }), 'error')
    }
  }
  const backupNow = async () => {
    const r = await writeBackupNow(session, { allowDownload: true })
    if (r.ok) toast(r.where === 'folder' ? t('settings.backupDone', { name: r.name }) : t('settings.backupDownloaded', { name: r.name }), 'ok', 6000)
    if (r.structureBlocked) toast(t('settings.structureBlocked', { n: r.structureBlocked }), 'warn', 8000)
  }
  return (
    <section class="cv-card">
      <h3>{t('settings.backup')}</h3>
      <p class="cv-muted">{t('settings.backupIntro')}</p>
      <div class="cv-label">
        {t('settings.backupFolder')}
        <div class="cv-actions">
          {fsAccessSupported() ? (
            <>
              <button type="button" class="cv-btn" onClick={() => void choose()}>
                {t('settings.backupFolderChoose')}
              </button>
              <span class="cv-muted">{dirName ? t('settings.backupFolderChosen', { name: dirName, keep: 10 }) : t('settings.backupFolderNone')}</span>
            </>
          ) : (
            <span class="cv-muted">{t('settings.backupFolderUnsupported')}</span>
          )}
        </div>
      </div>
      <div class="cv-actions">
        <button type="button" class="cv-btn cv-btn-primary" onClick={() => void backupNow()}>
          {t('settings.backupNow')}
        </button>
        <span class="cv-muted">{settings.lastBackupAt ? t('settings.lastBackup', { date: shortDate(settings.lastBackupAt) }) : t('settings.lastBackupNever')}</span>
      </div>
    </section>
  )
}

function ImportSection() {
  const session = getSession()
  const [file, setFile] = useState<BackupFile | null>(null)
  const [fileName, setFileName] = useState('')
  const [pw, setPw] = useState('')
  const [plan, setPlan] = useState<MergePlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<string | null>(null)

  const onFile = async (f: File | undefined) => {
    setPlan(null)
    setError(null)
    setTestResult(null)
    if (!f) return
    try {
      setFile(parseBackup(await f.text()))
      setFileName(f.name)
    } catch (e) {
      setFile(null)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const analyze = async () => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const { records } = await openBackup(file, { password: pw })
      setPlan(planMerge(await session.allDecoded(), records))
    } catch (e) {
      setError(e instanceof WrongPasswordError ? t('unlock.wrong') : e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    if (!file) return
    setBusy(true)
    try {
      const r = await testRestore(file, { password: pw })
      setTestResult(t('settings.testRestoreOk', { counts: Object.entries(r.counts).map(([k, v]) => `${k}: ${v}`).join(', ') }))
      await session.updateSettings({ lastBackupVerifiedAt: new Date().toISOString() })
    } catch (e) {
      setError(e instanceof WrongPasswordError ? t('unlock.wrong') : e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const merge = async () => {
    if (!plan) return
    setBusy(true)
    try {
      await session.applyMerge(plan)
      toast(t('settings.importDone'), 'ok')
      setPlan(null)
      setFile(null)
    } finally {
      setBusy(false)
    }
  }

  const replace = async () => {
    if (!file) return
    setBusy(true)
    try {
      await restoreIntoStore(store, file)
      const fresh = await VaultSession.open(store, { password: pw }, { appVersion: APP_VERSION })
      session.lock()
      setSession(fresh)
      toast(t('settings.importDone'), 'ok')
      setPlan(null)
      setFile(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const origin = file ? compareOrigin(session.header, file.header) : null
  const localEmpty = session.listScripts().length === 0 && session.listFields(true).length === 0

  return (
    <section class="cv-card">
      <h3>{t('settings.import')}</h3>
      <label class="cv-label">
        {t('settings.importFile')}
        <input type="file" accept=".enc,.json,application/json" onChange={(e) => void onFile((e.currentTarget as HTMLInputElement).files?.[0])} />
      </label>
      {file && (
        <>
          <p class="cv-muted">
            {fileName} · {t('settings.importOrigin', { device: file.header.deviceId.slice(0, 8), rev: file.header.revision, local: session.header.revision })}
            {origin?.fromOtherDevice && <span class="cv-warn"> {t('settings.importOtherDevice')}</span>}
          </p>
          <label class="cv-label">
            {t('settings.importPassword')}
            <SecretInput value={pw} onInput={setPw} ariaLabel={t('settings.importPassword')} />
          </label>
          <div class="cv-actions">
            <button type="button" class="cv-btn cv-btn-primary" onClick={() => void analyze()} disabled={busy || !pw}>
              {t('settings.importAnalyze')}
            </button>
            <button type="button" class="cv-btn" onClick={() => void test()} disabled={busy || !pw}>
              {t('settings.testRestore')}
            </button>
            {localEmpty && (
              <button type="button" class="cv-btn cv-btn-danger" onClick={() => void replace()} disabled={busy || !pw}>
                {t('settings.importReplace')}
              </button>
            )}
          </div>
        </>
      )}
      {testResult && <div class="cv-callout cv-callout-ok">{testResult}</div>}
      {error && <div class="cv-callout cv-callout-error">{error}</div>}
      {plan && (
        <Modal title={t('settings.importPreview')} onClose={() => setPlan(null)} wide>
          {planIsEmpty(plan) ? (
            <p>{t('settings.importNothing')}</p>
          ) : (
            <>
              <ul class="cv-list cv-list-compact">
                {plan.preview.map((p) => (
                  <li key={p.scriptId}>
                    {t('settings.importScriptRow', { title: p.title, incoming: p.incomingVersions, present: p.alreadyPresent, added: p.newVersions, isNew: p.isNewScript ? t('settings.importNewScript') : '' })}
                  </li>
                ))}
              </ul>
              <p class="cv-muted">
                {t('settings.importSummary', {
                  scripts: plan.summary.scriptsAdded,
                  versions: plan.summary.versionsAdded,
                  fields: plan.summary.fieldsAdded,
                  updated: plan.summary.fieldsUpdated,
                  retired: plan.summary.retiredAdded,
                  allow: plan.summary.allowlistAdded,
                  excl: plan.summary.exclusionsAdded,
                })}
              </p>
              {plan.conflicts.length > 0 && (
                <div class="cv-callout cv-callout-warn">
                  <strong>{t('settings.importConflicts', { n: plan.conflicts.length })}</strong>
                  <ul>
                    {plan.conflicts.map((c) => (
                      <li key={c.fieldId}>{t('settings.importConflictRow', { name: c.name, differing: c.differing.join(', '), resolution: c.resolution === 'took-incoming' ? t('settings.tookIncoming') : t('settings.keptLocal') })}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
          <div class="cv-actions">
            {!planIsEmpty(plan) && (
              <button type="button" class="cv-btn cv-btn-primary" onClick={() => void merge()} disabled={busy}>
                {t('settings.importMerge')}
              </button>
            )}
            <button type="button" class="cv-btn" onClick={() => setPlan(null)}>
              {t('common.close')}
            </button>
          </div>
        </Modal>
      )}
    </section>
  )
}

function SecuritySection() {
  const session = getSession()
  const settings = session.getSettings()
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState(false)
  const [recovery, setRecovery] = useState<string | null>(null)
  const [lockMin, setLockMin] = useState(String(settings.lockTimeoutMinutes))
  const [hiddenMin, setHiddenMin] = useState(String(settings.hiddenTabLockMinutes))

  const change = async () => {
    if (next.length < 10) return toast(t('setup.tooShort'), 'warn')
    setBusy(true)
    try {
      await session.changePassword({ password: cur }, next)
      toast(t('settings.passwordChanged'), 'ok')
      setCur('')
      setNext('')
    } catch (e) {
      toast(e instanceof WrongPasswordError ? t('unlock.wrong') : t('common.error', { message: e instanceof Error ? e.message : String(e) }), 'error')
    } finally {
      setBusy(false)
    }
  }

  const rotate = async () => {
    setBusy(true)
    try {
      setRecovery(await session.rotateRecoveryKey(cur))
    } catch (e) {
      toast(e instanceof WrongPasswordError ? t('unlock.wrong') : t('common.error', { message: e instanceof Error ? e.message : String(e) }), 'error')
    } finally {
      setBusy(false)
    }
  }

  const saveTimeouts = async () => {
    await session.updateSettings({ lockTimeoutMinutes: Math.max(1, Number(lockMin) || 10), hiddenTabLockMinutes: Math.max(1, Number(hiddenMin) || 2) })
    startAutoLock()
    toast(t('settings.saved'), 'ok')
  }

  return (
    <section class="cv-card">
      <h3>{t('settings.security')}</h3>
      <div class="cv-grid-2">
        <label class="cv-label">
          {t('settings.currentPassword')}
          <SecretInput value={cur} onInput={setCur} ariaLabel={t('settings.currentPassword')} />
        </label>
        <label class="cv-label">
          {t('settings.newPassword')}
          <SecretInput value={next} onInput={setNext} ariaLabel={t('settings.newPassword')} />
        </label>
      </div>
      <div class="cv-actions">
        <button type="button" class="cv-btn cv-btn-primary" onClick={() => void change()} disabled={busy || !cur || !next}>
          {t('settings.changePassword')}
        </button>
        <button type="button" class="cv-btn" onClick={() => void rotate()} disabled={busy || !cur} title={t('settings.showRecoveryHint')}>
          {t('settings.showRecovery')}
        </button>
      </div>
      {recovery && (
        <Modal title={t('setup.recoveryTitle')} onClose={() => setRecovery(null)}>
          <p>{t('setup.recoveryIntro')}</p>
          <pre class="cv-pre cv-recovery" onContextMenu={(e) => e.preventDefault()}>
            {formatRecoveryKey(recovery)}
          </pre>
        </Modal>
      )}
      <div class="cv-grid-2">
        <label class="cv-label">
          {t('settings.lockTimeout')}
          <input class="cv-input" type="number" min={1} value={lockMin} onInput={(e) => setLockMin((e.currentTarget as HTMLInputElement).value)} />
        </label>
        <label class="cv-label">
          {t('settings.hiddenTimeout')}
          <input class="cv-input" type="number" min={1} value={hiddenMin} onInput={(e) => setHiddenMin((e.currentTarget as HTMLInputElement).value)} />
        </label>
      </div>
      <div class="cv-actions">
        <button type="button" class="cv-btn" onClick={() => void saveTimeouts()}>
          {t('common.save')}
        </button>
      </div>
    </section>
  )
}

function OrgSection() {
  const session = getSession()
  const settings = session.getSettings()
  const [domain, setDomain] = useState('')
  const [upn, setUpn] = useState('')
  const [netbios, setNetbios] = useState('')
  const [tenant, setTenant] = useState('')
  const [dc, setDc] = useState('')
  const [hostRegex, setHostRegex] = useState(settings.orgHostRegex ?? '')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    let n = 0
    const add = async (name: string, kind: FieldKind, real: string) => {
      const v = real.trim()
      if (!v) return
      if (session.findFieldByRealValue(v)) return
      await session.createField({ name, kind, real: v, scope: 'global' })
      n++
    }
    try {
      await add('AD_DOMAIN', 'domain', domain)
      await add('UPN_SUFFIX', 'domain', upn)
      await add('NETBIOS', 'domain', netbios)
      await add('TENANT_ID', 'tenantId', tenant)
      await add('PRIMARY_DC', 'server', dc)
      await session.updateSettings({ orgHostRegex: hostRegex.trim() || undefined, setupDone: [...new Set([...settings.setupDone, 'org'])] })
      toast(t('settings.orgSaved', { n }), 'ok')
      setDomain('')
      setUpn('')
      setNetbios('')
      setTenant('')
      setDc('')
    } catch (e) {
      toast(t('common.error', { message: e instanceof Error ? e.message : String(e) }), 'error')
    } finally {
      setBusy(false)
    }
  }

  const Field = ({ label, value, set }: { label: string; value: string; set: (v: string) => void }) => (
    <label class="cv-label">
      {label}
      <input class="cv-input" value={value} onInput={(e) => set((e.currentTarget as HTMLInputElement).value)} spellcheck={false} autocomplete="off" data-lpignore="true" />
    </label>
  )

  return (
    <section class="cv-card">
      <h3>{t('settings.org')}</h3>
      <p class="cv-muted">{t('settings.orgIntro')}</p>
      <div class="cv-grid-2">
        <Field label={t('settings.orgDomain')} value={domain} set={setDomain} />
        <Field label={t('settings.orgUpn')} value={upn} set={setUpn} />
        <Field label={t('settings.orgNetbios')} value={netbios} set={setNetbios} />
        <Field label={t('settings.orgTenant')} value={tenant} set={setTenant} />
        <Field label={t('settings.orgDc')} value={dc} set={setDc} />
        <Field label={t('settings.orgHostRegex')} value={hostRegex} set={setHostRegex} />
      </div>
      <div class="cv-actions">
        <button type="button" class="cv-btn cv-btn-primary" onClick={() => void save()} disabled={busy}>
          {t('settings.orgSave')}
        </button>
      </div>
    </section>
  )
}

function GeneralSection() {
  const session = getSession()
  const settings = session.getSettings()
  const [root, setRoot] = useState(settings.rootPath ?? '')
  const save = async (patch: Parameters<typeof session.updateSettings>[0]) => {
    await session.updateSettings(patch)
    if (patch.locale) setLocale(patch.locale)
    toast(t('settings.saved'), 'ok')
  }
  return (
    <section class="cv-card">
      <h3>{t('settings.general')}</h3>
      <div class="cv-grid-2">
        <label class="cv-label">
          {t('settings.rootPath')}
          <input class="cv-input" value={root} onInput={(e) => setRoot((e.currentTarget as HTMLInputElement).value)} onBlur={() => void save({ rootPath: root.trim() || undefined })} spellcheck={false} placeholder="C:\Temp" />
        </label>
        <label class="cv-label">
          {t('settings.locale')}
          <select class="cv-input" value={settings.locale} onChange={(e) => void save({ locale: (e.currentTarget as HTMLSelectElement).value as 'sv' | 'en' })}>
            <option value="sv">Svenska</option>
            <option value="en">English</option>
          </select>
        </label>
      </div>
      <label class="cv-check">
        <input type="checkbox" checked={settings.hideAllPathsFromAi} onChange={(e) => void save({ hideAllPathsFromAi: (e.currentTarget as HTMLInputElement).checked })} /> {t('settings.hidePaths')}
      </label>
      <label class="cv-check">
        <input type="checkbox" checked={settings.preambleForAi} onChange={(e) => void save({ preambleForAi: (e.currentTarget as HTMLInputElement).checked })} /> {t('settings.preamble')}
      </label>
    </section>
  )
}

function FieldsSection() {
  const session = getSession()
  const fields = session.listFields(true)
  const allow = session.listAllowlist()
  return (
    <section class="cv-card">
      <h3>{t('settings.fields')}</h3>
      <table class="cv-table">
        <thead>
          <tr>
            <th>{t('field.name')}</th>
            <th>{t('field.kind')}</th>
            <th>{t('field.example')}</th>
            <th>{t('field.scope')}</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => (
            <tr key={f.id} class={f.tombstone ? 'cv-field-tombstone' : ''}>
              <td>{f.name}</td>
              <td>{kindLabel(f.kind)}</td>
              <td>
                <code>{f.example.length > 40 ? f.example.slice(0, 40) + '…' : f.example}</code>
              </td>
              <td>{f.scope === 'global' ? t('field.scopeGlobal') : t('field.scopeScript')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {allow.length > 0 && (
        <>
          <h4>{t('settings.allowlist')}</h4>
          <ul class="cv-list cv-list-compact">
            {allow.map((a) => (
              <li key={a.id}>
                <code>{a.value}</code>{' '}
                <button type="button" class="cv-btn cv-btn-small cv-btn-ghost" onClick={() => void session.removeAllowlist(a.id)}>
                  {t('settings.allowlistRemove')}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
