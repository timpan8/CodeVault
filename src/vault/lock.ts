/**
 * Auto-lock controller: idle timeout, hidden-tab timeout, explicit lock.
 * DOM listeners are attached only when a document exists, so the class is
 * fully testable in Node with injected timers.
 */
export interface LockControllerOptions {
  idleMs: number
  hiddenMs: number
  onLock: () => void
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const

export class LockController {
  private idleTimer: unknown
  private hiddenTimer: unknown
  private running = false
  private lastActivity = 0
  private readonly onActivity = () => this.activity()
  private readonly onVisibility = () => {
    if (typeof document === 'undefined') return
    if (document.hidden) this.documentHidden()
    else this.documentVisible()
  }

  constructor(private opts: LockControllerOptions) {}

  private set(fn: () => void, ms: number): unknown {
    return (this.opts.setTimeout ?? ((f, m) => setTimeout(f, m)))(fn, ms)
  }

  private clear(handle: unknown): void {
    if (handle === undefined) return
    ;(this.opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(handle)
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.resetIdle()
    if (typeof document !== 'undefined') {
      for (const ev of ACTIVITY_EVENTS) document.addEventListener(ev, this.onActivity, { passive: true })
      document.addEventListener('visibilitychange', this.onVisibility)
    }
  }

  stop(): void {
    this.running = false
    this.clear(this.idleTimer)
    this.clear(this.hiddenTimer)
    this.idleTimer = undefined
    this.hiddenTimer = undefined
    if (typeof document !== 'undefined') {
      for (const ev of ACTIVITY_EVENTS) document.removeEventListener(ev, this.onActivity)
      document.removeEventListener('visibilitychange', this.onVisibility)
    }
  }

  /** Any user interaction; throttled to once per second. */
  activity(now = Date.now()): void {
    if (!this.running) return
    if (now - this.lastActivity < 1000) return
    this.lastActivity = now
    this.resetIdle()
  }

  documentHidden(): void {
    if (!this.running || this.hiddenTimer !== undefined) return
    this.hiddenTimer = this.set(() => this.fire(), this.opts.hiddenMs)
  }

  documentVisible(): void {
    this.clear(this.hiddenTimer)
    this.hiddenTimer = undefined
    this.resetIdle()
  }

  lockNow(): void {
    this.fire()
  }

  private resetIdle(): void {
    this.clear(this.idleTimer)
    this.idleTimer = this.set(() => this.fire(), this.opts.idleMs)
  }

  private fire(): void {
    if (!this.running) return
    this.stop()
    this.opts.onLock()
  }
}
