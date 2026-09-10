/**
 * The masking rule lives in one place. These tests exist so a new FieldKind, or
 * a future "let the user re-classify a field", has to face the question rather
 * than drift: masksByDefault also gates needsReview and the "copy real" block.
 */
import { describe, expect, it } from 'vitest'
import { defaultSensitivity, kindMasksByDefault, masksByDefault } from '@engine/fields'
import { FIELD_KINDS } from '@engine/types'

describe('masking rule', () => {
  it('masksByDefault reads the field sensitivity, nothing else', () => {
    expect(masksByDefault({ sensitivity: 'secret' })).toBe(true)
    expect(masksByDefault({ sensitivity: 'internal' })).toBe(false)
    expect(masksByDefault({ sensitivity: 'public' })).toBe(false)
    expect(masksByDefault(undefined)).toBe(false)
  })

  it('kindMasksByDefault agrees with defaultSensitivity for every kind', () => {
    for (const kind of FIELD_KINDS) {
      expect(kindMasksByDefault(kind), kind).toBe(defaultSensitivity(kind) === 'secret')
    }
    expect(FIELD_KINDS.filter(kindMasksByDefault)).toEqual(['password', 'apiKey', 'blob'])
    expect(kindMasksByDefault(undefined)).toBe(false)
  })

  it('a path is never a secret by default, whatever its real value looks like', () => {
    expect(defaultSensitivity('path', 'C:\\Temp\\x')).toBe('public')
    expect(defaultSensitivity('path', 'C:\\Users\\tim.pan\\x')).toBe('internal')
    expect(kindMasksByDefault('path')).toBe(false)
  })
})
