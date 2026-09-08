import type { FieldKind } from '@engine/types'
import { t, type StringKey } from '@i18n/index'

export function kindLabel(kind: FieldKind): string {
  return t(`field.kind.${kind}` as StringKey)
}

export function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return iso
  const diff = Math.max(0, now - then)
  const min = Math.round(diff / 60_000)
  if (min < 1) return 'nu'
  if (min < 60) return `${min} min`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} h`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} d`
  return iso.slice(0, 10)
}

export function shortDate(iso: string): string {
  return iso.replace('T', ' ').slice(0, 16)
}

export function mask(value: string): string {
  return '•'.repeat(Math.min(12, Math.max(6, value.length)))
}

export function downloadText(name: string, content: string, mime = 'text/plain'): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Windows folder name from a title: ASCII only, reserved device names rejected. */
export function slugify(title: string): { slug: string; warnings: string[] } {
  const warnings: string[] = []
  let s = title
    .replace(/[åä]/g, 'a')
    .replace(/[ÅÄ]/g, 'A')
    .replace(/ö/g, 'o')
    .replace(/Ö/g, 'O')
    .replace(/[^A-Za-z0-9 _-]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/[. ]+$/g, '')
  if (/[åäöÅÄÖ]/.test(title)) warnings.push('non-ascii')
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(s)) {
    s = s + '-script'
    warnings.push('reserved')
  }
  if (s === '') s = 'Project01'
  return { slug: s, warnings }
}

/** Title suggestion from a PowerShell script: .SYNOPSIS, first function, first comment. */
export function suggestTitle(text: string): string {
  const syn = /\.SYNOPSIS\s*\r?\n\s*(.+)/i.exec(text)
  if (syn?.[1]) return syn[1].trim().slice(0, 80)
  const fn = /^\s*function\s+([A-Za-z][\w-]*)/im.exec(text)
  if (fn?.[1]) return fn[1]
  const comment = /^\s*#\s*(.+)$/m.exec(text)
  if (comment?.[1] && !/^\[REAL VALUES|^Placeholder values/.test(comment[1])) return comment[1].trim().slice(0, 80)
  return 'Nytt skript'
}
