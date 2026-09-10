import { describe, expect, it } from 'vitest'
import { DEFAULT_NAMESPACE, generateExample, isInExampleNamespace, isToolExample, knownExamples, nextExample } from '@engine/examples'
import { FIELD_KINDS } from '@engine/types'
import { matchRuleFor, needsEscapingChars, normalizeAnchorName, pathSensitivity, suggestFieldName, validateExample } from '@engine/fields'

describe('example generator', () => {
  it('produces escape-free, namespaced, unique values per kind', () => {
    for (const kind of FIELD_KINDS) {
      const seen = new Set<string>()
      for (let n = 1; n <= 30; n++) {
        const ex = generateExample(kind, n)
        expect(needsEscapingChars(ex), `${kind} ${ex}`).toBe(false)
        expect(ex.length, ex).toBeGreaterThanOrEqual(6)
        expect(isInExampleNamespace(ex), `${kind} ${ex}`).toBe(true)
        expect(seen.has(ex.toLowerCase()), `${kind} duplicate ${ex}`).toBe(false)
        seen.add(ex.toLowerCase())
      }
    }
  })

  it('follows the shape of the real value', () => {
    expect(generateExample('server', 1, DEFAULT_NAMESPACE, { shapeOf: 'dc01' })).toBe('SRV-EXAMPLE01')
    expect(generateExample('server', 1, DEFAULT_NAMESPACE, { shapeOf: 'dc01.corp.local' })).toBe('SRV-EXAMPLE01.corp.example')
    expect(generateExample('domain', 1, DEFAULT_NAMESPACE, { shapeOf: 'CONTOSO' })).toBe('EXAMPLE')
    expect(generateExample('username', 1, DEFAULT_NAMESPACE, { shapeOf: 'CORP\\svc' })).toBe('EXAMPLE\\svc-example01')
    expect(generateExample('path', 1, DEFAULT_NAMESPACE, { aiVisibleName: 'Project01' })).toBe('C:\\Example\\Project01')
  })

  it('nextExample skips used values', () => {
    const used = [{ example: 'svc-example01' }, { example: 'SVC-EXAMPLE02' }]
    expect(nextExample('username', used)).toBe('svc-example03')
  })

  it('namespace detection rejects real-looking values', () => {
    for (const real of ['contoso.com', 'dc01.corp.local', '10.0.0.5', 'Sommar2024!', 'C:\\Temp\\Proj']) {
      expect(isInExampleNamespace(real), real).toBe(false)
    }
    expect(isInExampleNamespace('192.0.2.11')).toBe(true)
    expect(isInExampleNamespace('anna.exempel1@example.com')).toBe(true)
  })
})

describe('field rules', () => {
  it('match rule thresholds', () => {
    expect(matchRuleFor('tp')).toBe('anchor-only')
    expect(matchRuleFor('abcd')).toBe('whole-token')
    expect(matchRuleFor('abcdefg')).toBe('whole-token')
    expect(matchRuleFor('abcdefgh')).toBe('substring')
  })

  it('validateExample', () => {
    const base = { kind: 'username' as const, otherExamples: ['svc-example01'], realValues: ['jdoe'] }
    expect(validateExample('svc-example01', base)).toContain('not-unique')
    expect(validateExample('svc', base)).toContain('too-short')
    expect(validateExample("it's-example", base)).toContain('needs-escaping')
    expect(validateExample('svc-example', base)).toContain('substring-of-other')
    expect(validateExample('svc-example01x', base)).toContain('contains-other')
    expect(validateExample('svc-example02', base)).toEqual([])
    expect(validateExample('jdoe-example', { ...base, realValues: ['jdoe-example'] })).toContain('equals-real')
    // paths may prefix each other
    expect(validateExample('C:\\Example\\P\\Logs', { kind: 'path', otherExamples: ['C:\\Example\\P'], realValues: [] })).toEqual([])
  })

  it('anchor names and sensitivity helpers', () => {
    expect(normalizeAnchorName('$script:AdminUser')).toBe('adminuser')
    expect(normalizeAnchorName('-Path:')).toBe('path')
    expect(normalizeAnchorName('${my var}')).toBe('my var')
    expect(pathSensitivity('C:\\Temp\\x')).toBe('public')
    expect(pathSensitivity('C:\\Users\\tim.pan\\x')).toBe('internal')
    expect(pathSensitivity('\\\\fs01\\share')).toBe('internal')
    expect(suggestFieldName('password', '$AdminPw')).toBe('ADMINPW')
    expect(suggestFieldName('password')).toBe('PASSWORD')
  })
})

describe('values the tool claims as its own', () => {
  const fields = [
    { example: 'web-frontend.acme-demo.net', aliases: [{ value: 'web-frontend.acme-demo.io', anchorOnly: false }, { value: 'admin', anchorOnly: true }] },
    { example: 'SRV-EXAMPLE01.corp.example', aliases: [] },
  ]

  it('knownExamples collects examples and real aliases, never anchor-only ones', () => {
    const known = knownExamples(fields)
    expect([...known].sort()).toEqual(['srv-example01.corp.example', 'web-frontend.acme-demo.io', 'web-frontend.acme-demo.net'])
  })

  it('isToolExample accepts a chosen example outside the reserved namespace', () => {
    const known = knownExamples(fields)
    // The namespace test alone cannot see a value the user chose.
    expect(isInExampleNamespace('web-frontend.acme-demo.net', DEFAULT_NAMESPACE)).toBe(false)
    expect(isToolExample('web-frontend.acme-demo.net', DEFAULT_NAMESPACE, known)).toBe(true)
    // Case-insensitive, since the set is lower-cased.
    expect(isToolExample('WEB-Frontend.Acme-Demo.NET', DEFAULT_NAMESPACE, known)).toBe(true)
    // An anchor-only alias failed the example rules, so it stays untrusted.
    expect(isToolExample('admin', DEFAULT_NAMESPACE, known)).toBe(false)
    // Namespace values still pass with no set at all.
    expect(isToolExample('svc-example01')).toBe(true)
    expect(isToolExample('dc01.corp.contoso.se', DEFAULT_NAMESPACE, known)).toBe(false)
  })
})
