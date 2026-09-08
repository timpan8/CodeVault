/**
 * Clipboard ownership. Only text/plain is ever written. After a REAL copy a
 * countdown clears the clipboard; the clear is reported as done only when
 * the write actually succeeded (an unfocused tab is refused by the browser),
 * otherwise it retries on focus/visibility and the banner stays honest.
 */
import { signal } from '@preact/signals'

export type ClipboardStatus = 'clean' | 'real' | 'pending-clear'

export const clipboardStatus = signal<ClipboardStatus>('clean')
export const clipboardCountdown = signal(0)

const CLEAR_AFTER_S = 30
let countdownTimer: ReturnType<typeof setInterval> | undefined
let generation = 0

async function rawWrite(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function stopCountdown(): void {
  if (countdownTimer !== undefined) clearInterval(countdownTimer)
  countdownTimer = undefined
  clipboardCountdown.value = 0
}

/** Every tool-initiated copy cancels a pending clear: the clipboard is now something else. */
export async function writeClipboard(text: string, kind: 'ai' | 'real'): Promise<boolean> {
  generation++
  stopCountdown()
  const ok = await rawWrite(text)
  if (!ok) return false
  if (kind === 'ai') {
    clipboardStatus.value = 'clean'
    return true
  }
  clipboardStatus.value = 'real'
  const myGeneration = generation
  clipboardCountdown.value = CLEAR_AFTER_S
  countdownTimer = setInterval(() => {
    if (myGeneration !== generation) return
    clipboardCountdown.value = Math.max(0, clipboardCountdown.value - 1)
    if (clipboardCountdown.value === 0) {
      stopCountdown()
      void clearRealClipboard(myGeneration)
    }
  }, 1000)
  return true
}

export async function clearRealClipboard(expectedGeneration = generation): Promise<void> {
  if (expectedGeneration !== generation) return
  if (clipboardStatus.value === 'clean') return
  const ok = await rawWrite(' ')
  if (expectedGeneration !== generation) return
  if (ok) {
    stopCountdown()
    clipboardStatus.value = 'clean'
  } else {
    clipboardStatus.value = 'pending-clear'
  }
}

let listenersInstalled = false
export function installClipboardListeners(): void {
  if (listenersInstalled || typeof window === 'undefined') return
  listenersInstalled = true
  const retry = () => {
    if (clipboardStatus.value === 'pending-clear') void clearRealClipboard()
  }
  window.addEventListener('focus', retry)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) retry()
  })
}
