import { sv, type StringKey } from './sv'
import { en } from './en'

export type Locale = 'sv' | 'en'
export type { StringKey }

let current: Locale = 'sv'

export function setLocale(locale: Locale): void {
  current = locale
}

export function getLocale(): Locale {
  return current
}

/**
 * Look up a UI string. `{name}` placeholders are replaced from `params`.
 * Unknown keys return the key itself so a missing string is visible, never a crash.
 */
export function t(key: StringKey, params?: Record<string, string | number>): string {
  const table: Partial<Record<StringKey, string>> = current === 'en' ? en : sv
  let text: string = table[key] ?? sv[key] ?? key
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.split(`{${name}}`).join(String(value))
    }
  }
  return text
}
