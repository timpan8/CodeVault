import { describe, expect, it } from 'vitest'
import { applyEol, detectElision, normalizePaste, normalizeText, splitFences, stripSentinels } from '@engine/normalize'
import { SENTINEL_PREAMBLE, SENTINEL_REAL } from '@engine/sentinels'

describe('normalizeText', () => {
  it('strips BOM, detects CRLF, normalises to LF, trims only the final line', () => {
    const r = normalizeText('\uFEFFa  \r\nb\r\nc   ')
    expect(r.hadBom).toBe(true)
    expect(r.eol).toBe('crlf')
    expect(r.text).toBe('a  \nb\nc')
  })

  it('applyEol', () => {
    expect(applyEol('a\nb\r\nc', 'crlf')).toBe('a\r\nb\r\nc')
    expect(applyEol('a\r\nb', 'lf')).toBe('a\nb')
  })
})

describe('fences and sentinels', () => {
  it('splits multiple fenced blocks and keeps prose', () => {
    const raw = 'Here is the script:\n```powershell\nGet-Item x\n```\nand a one-liner\n```\nNew-Item y\n```\ndone'
    const r = splitFences(raw)
    expect(r.blocks.map((b) => [b.lang, b.text])).toEqual([
      ['powershell', 'Get-Item x'],
      [null, 'New-Item y'],
    ])
    expect(r.prose).toContain('Here is the script:')
    expect(r.prose).toContain('done')
  })

  it('strips both sentinels and reports them', () => {
    const r = stripSentinels(`${SENTINEL_PREAMBLE}\n\n$x = 1\n${SENTINEL_REAL}\n$y = 2`)
    expect(r.text).toBe('$x = 1\n$y = 2')
    expect(r.stripped).toEqual(['preamble', 'real'])
  })

  it('normalizePaste end to end', () => {
    const r = normalizePaste(`\uFEFF\`\`\`powershell\r\n${SENTINEL_REAL}\r\n$x = 1\r\n# ... rest unchanged ...\r\n\`\`\`\r\n`)
    expect(r.blocks).toHaveLength(1)
    expect(r.blocks[0]!.text).toBe('$x = 1\n# ... rest unchanged ...')
    expect(r.eol).toBe('crlf')
    expect(r.containedRealSentinel).toBe(true)
    expect(r.looksPartial).toBe(true)
  })

  it('unfenced paste is a single block', () => {
    const r = normalizePaste('$x = 1\n$y = 2')
    expect(r.blocks).toHaveLength(1)
    expect(r.prose).toBe('')
    expect(r.looksPartial).toBe(false)
  })

  it('elision detection', () => {
    expect(detectElision('# resten av skriptet oförändrad')).toBe(true)
    expect(detectElision('# existing code here')).toBe(true)
    expect(detectElision('# ...')).toBe(true)
    expect(detectElision('# Export users')).toBe(false)
  })
})
