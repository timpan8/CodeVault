import { afterEach, describe, expect, it } from 'vitest'
import { setLocale, t } from '@i18n/index'

describe('i18n', () => {
  afterEach(() => setLocale('sv'))

  it('interpolates params', () => {
    expect(t('app.networkRequests', { count: 0 })).toBe('Nätverksanrop denna session: 0')
  })

  it('falls back to Swedish for missing English keys', () => {
    setLocale('en')
    expect(t('app.title')).toBe('CodeVault')
  })
})
