/**
 * Application state: phase, route, the unlocked session, engine client,
 * toasts and the auto-lock controller. Components read signals; the session
 * itself is a class held outside signals and `tick` bumps on every change.
 */
import { signal } from '@preact/signals'
import { VaultStore } from '@vault/store'
import { VaultSession } from '@vault/session'
import { LockController } from '@vault/lock'
import { createEngineClient, type EngineApi } from '@engine/client'
import { setLocale } from '@i18n/index'

export const APP_VERSION = '0.1.0'

export type Route =
  | { view: 'scripts' }
  | { view: 'script'; scriptId: string; versionId?: string }
  | { view: 'sanitize' }
  | { view: 'settings' }
  | { view: 'about' }

export type Phase = 'loading' | 'setup' | 'locked' | 'unlocked'

export const phase = signal<Phase>('loading')
export const route = signal<Route>({ view: 'scripts' })
export const tick = signal(0)
export const lockReason = signal<'idle' | 'manual' | null>(null)

export interface Toast {
  id: number
  message: string
  kind: 'info' | 'ok' | 'warn' | 'error'
}
export const toasts = signal<Toast[]>([])

export const store = new VaultStore('codevault')
export const engine: EngineApi = createEngineClient()

let session: VaultSession | null = null
let unsubscribe: (() => void) | null = null
let lockController: LockController | null = null
let nextToast = 1

export function hasSession(): boolean {
  return session !== null && !session.isLocked
}

export function getSession(): VaultSession {
  if (!session || session.isLocked) throw new Error('Vault is locked')
  return session
}

export function setSession(s: VaultSession | null): void {
  unsubscribe?.()
  unsubscribe = null
  session = s
  if (s) {
    unsubscribe = s.subscribe(() => {
      tick.value++
    })
    setLocale(s.getSettings().locale)
    startAutoLock()
    phase.value = 'unlocked'
  }
  tick.value++
}

export function navigate(r: Route): void {
  route.value = r
}

export function toast(message: string, kind: Toast['kind'] = 'info', ms = 4000): void {
  const id = nextToast++
  toasts.value = [...toasts.value, { id, message, kind }]
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }, ms)
}

export function startAutoLock(): void {
  lockController?.stop()
  if (!session) return
  const settings = session.getSettings()
  lockController = new LockController({
    idleMs: Math.max(1, settings.lockTimeoutMinutes) * 60_000,
    hiddenMs: Math.max(1, settings.hiddenTabLockMinutes) * 60_000,
    onLock: () => lock('idle'),
  })
  lockController.start()
}

/** Hooks called right before the session is dropped (e.g. write a backup). */
const beforeLockHooks = new Set<() => Promise<void> | void>()
export function onBeforeLock(fn: () => Promise<void> | void): () => void {
  beforeLockHooks.add(fn)
  return () => beforeLockHooks.delete(fn)
}

export async function lock(reason: 'idle' | 'manual' = 'manual'): Promise<void> {
  if (!session) return
  lockController?.stop()
  lockController = null
  for (const fn of beforeLockHooks) {
    try {
      await fn()
    } catch {
      // a failed backup must never keep the vault open
    }
  }
  session.lock()
  session = null
  unsubscribe?.()
  unsubscribe = null
  lockReason.value = reason
  phase.value = 'locked'
  tick.value++
}

export function useTick(): number {
  return tick.value
}
