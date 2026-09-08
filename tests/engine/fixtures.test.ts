/**
 * Fixture corpus for the re-apply engine. Each directory under
 * tests/fixtures/<category>/<case> holds fields.json, paste.txt,
 * expected.json and optionally prev.tmpl, config.json,
 * expected.real.txt, expected.example.txt.
 *
 * Hard invariants across the corpus:
 * - wrong auto-applies == 0 (an 'auto' slot the fixture did not expect as auto)
 * - every expected slot is found with the expected status
 * - no unexpected 'confirm' rows (yellow budget) and at most 3 unexpected candidates
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyProposals, reapply, type ReapplyInput, type SlotProposal } from '@engine/reapply'
import { parseTemplate, render } from '@engine/template'
import { guard } from '@engine/guard'
import { createField } from '@engine/fields'
import type { Field, FieldKind } from '@engine/types'

const ROOT = fileURLToPath(new URL('../fixtures', import.meta.url))
const NOW = '2026-01-01T00:00:00.000Z'

interface FixtureField {
  id: string
  name: string
  kind: FieldKind
  example: string
  scope?: Field['scope']
  nameAnchors?: string[]
  aliases?: Field['aliases']
  real?: string
  other?: boolean
}

interface ExpectedSlot {
  fieldId: string | null
  line: number
  status: 'auto' | 'confirm' | 'candidate'
  kindGuess?: FieldKind
  literal?: string
  why?: string
  suffix?: string
  warnings?: string[]
}

interface Expected {
  slots: ExpectedSlot[]
  missing?: string[]
  unknown?: string[]
  flags?: Partial<{ realValuesFound: string[]; retiredFound: string[]; directionWarning: boolean }>
}

function listFixtures(): string[] {
  const out: string[] = []
  for (const cat of readdirSync(ROOT)) {
    const catDir = join(ROOT, cat)
    if (!statSync(catDir).isDirectory()) continue
    for (const c of readdirSync(catDir)) {
      const dir = join(catDir, c)
      if (existsSync(join(dir, 'expected.json'))) out.push(`${cat}/${c}`)
    }
  }
  return out.sort()
}

function load(name: string) {
  const dir = join(ROOT, name)
  const read = (f: string) => readFileSync(join(dir, f), 'utf8')
  const fields = JSON.parse(read('fields.json')) as FixtureField[]
  const expected = JSON.parse(read('expected.json')) as Expected
  const config = existsSync(join(dir, 'config.json'))
    ? (JSON.parse(read('config.json')) as {
        mode?: 'ai' | 'editor'
        language?: 'powershell' | 'plain'
        retired?: Array<{ fieldId: string; value: string }>
        exclusions?: Array<{ fieldId: string; lineFp: string }>
        orgHostRegex?: string
      })
    : {}
  const prev = existsSync(join(dir, 'prev.tmpl')) ? read('prev.tmpl') : undefined
  const real = existsSync(join(dir, 'expected.real.txt')) ? read('expected.real.txt') : undefined
  const example = existsSync(join(dir, 'expected.example.txt')) ? read('expected.example.txt') : undefined
  return { paste: read('paste.txt'), fields, expected, config, prev, real, example }
}

const corpusStats = { fixtures: 0, expectedSlots: 0, found: 0, wrongAuto: 0 }

describe('re-apply fixture corpus', () => {
  const names = listFixtures()
  expect(names.length).toBeGreaterThan(0)

  for (const name of names) {
    it(name, () => {
      const fx = load(name)
      const own: Field[] = []
      const other: Field[] = []
      const realMap = new Map<string, string>()
      for (const f of fx.fields) {
        const field: Field = {
          ...createField({ id: f.id, name: f.name, kind: f.kind, example: f.example, now: NOW, ...(f.scope ? { scope: f.scope } : {}) }),
          nameAnchors: f.nameAnchors ?? [],
          aliases: f.aliases ?? [],
        }
        ;(f.other ? other : own).push(field)
        if (f.real !== undefined) realMap.set(f.id, f.real)
      }
      const allFields = new Map([...own, ...other].map((f) => [f.id, f]))
      const input: ReapplyInput = {
        text: fx.paste,
        fields: own,
        otherFields: other,
        real: realMap,
        mode: fx.config.mode ?? 'ai',
        ...(fx.config.language ? { language: fx.config.language } : {}),
        ...(fx.config.retired ? { retired: fx.config.retired } : {}),
        ...(fx.config.exclusions ? { exclusions: fx.config.exclusions } : {}),
        ...(fx.config.orgHostRegex ? { orgHostRegex: new RegExp(fx.config.orgHostRegex, 'i') } : {}),
        ...(fx.prev ? { prev: { segments: parseTemplate(fx.prev) } } : {}),
      }
      const result = reapply(input)
      corpusStats.fixtures++

      const describeSlot = (s: SlotProposal) =>
        `${s.fieldId ?? 'null'}@L${s.line + 1}:${s.status}(${s.why}${s.kindGuess ? ',' + s.kindGuess : ''}${s.warnings.length ? ',' + s.warnings.join('+') : ''}) "${s.literal.slice(0, 40)}"`
      const got = result.slots.map(describeSlot).join('\n  ')

      const matched = new Set<SlotProposal>()
      for (const exp of fx.expected.slots) {
        corpusStats.expectedSlots++
        const cand = result.slots.find(
          (s) =>
            !matched.has(s) &&
            s.fieldId === exp.fieldId &&
            s.line === exp.line - 1 &&
            (exp.literal === undefined || s.literal === exp.literal) &&
            (exp.kindGuess === undefined || s.kindGuess === exp.kindGuess),
        )
        expect(cand, `expected ${exp.fieldId}@L${exp.line} not found. Got:\n  ${got}`).toBeDefined()
        if (!cand) continue
        corpusStats.found++
        matched.add(cand)
        expect(cand.status, `status of ${exp.fieldId}@L${exp.line}. Got:\n  ${got}`).toBe(exp.status)
        if (exp.why !== undefined) expect(cand.why, `why of ${exp.fieldId}@L${exp.line}`).toBe(exp.why)
        if (exp.suffix !== undefined) expect(cand.suffix).toBe(exp.suffix)
        for (const w of exp.warnings ?? []) expect(cand.warnings, `warnings of ${exp.fieldId}@L${exp.line}`).toContain(w)
      }
      const unexpected = result.slots.filter((s) => !matched.has(s))
      const wrongAuto = unexpected.filter((s) => s.status === 'auto')
      corpusStats.wrongAuto += wrongAuto.length
      expect(wrongAuto.map(describeSlot), `WRONG AUTO-APPLY. Got:\n  ${got}`).toEqual([])
      expect(
        unexpected.filter((s) => s.status === 'confirm').map(describeSlot),
        `unexpected confirm rows (yellow budget). Got:\n  ${got}`,
      ).toEqual([])
      expect(unexpected.length, `too many unexpected candidates. Got:\n  ${got}`).toBeLessThanOrEqual(3)

      expect(result.missing.map((m) => m.fieldId).sort()).toEqual([...(fx.expected.missing ?? [])].sort())
      expect(result.unknown.map((u) => u.literal).sort()).toEqual([...(fx.expected.unknown ?? [])].sort())
      if (fx.expected.flags) {
        for (const [k, v] of Object.entries(fx.expected.flags)) {
          expect(result.flags[k as keyof typeof result.flags], `flag ${k}`).toEqual(v)
        }
      }

      const accepted = result.slots.filter((s) => s.fieldId !== null && s.status !== 'candidate')
      const segments = applyProposals(fx.paste, accepted)
      const plain = fx.config.language === 'plain'
      if (fx.example !== undefined) {
        expect(render(segments, 'example', { fields: allFields, plain }).text).toBe(fx.example)
      } else if (
        input.mode === 'ai' &&
        !result.flags.directionWarning &&
        accepted.every((s) => s.literal.toLowerCase() === allFields.get(s.fieldId!)?.example.toLowerCase())
      ) {
        // With only canonical example hits in the paste, the example rendering must reproduce it exactly.
        expect(render(segments, 'example', { fields: allFields, plain }).text).toBe(fx.paste)
      }
      if (fx.real !== undefined) {
        const realText = render(segments, 'real', { fields: allFields, real: realMap, plain }).text
        expect(realText).toBe(fx.real)
        // The guard must catch the real values in the real rendering.
        const g = guard({ text: realText, fields: [...allFields.values()], real: realMap, language: plain ? 'plain' : 'powershell' })
        expect(g.findings.filter((f) => f.pass === 1).length).toBeGreaterThan(0)
      }
      // Corpus invariant: once every unknown real value is resolved, the sanitized
      // rendering never contains a real value or a residual marker. Editor-mode
      // fixtures with unresolved unknowns are exactly the case the guard must block.
      const exampleText = render(segments, 'example', { fields: allFields, plain }).text
      if (result.unknown.length > 0) {
        const blocked = guard({ text: exampleText, fields: [...allFields.values()], real: realMap, language: plain ? 'plain' : 'powershell' })
        expect(blocked.blocked, 'guard must block while unknown real values remain').toBe(true)
        return
      }
      const g = guard({
        text: exampleText,
        fields: [...allFields.values()],
        real: realMap,
        ...(fx.config.retired ? { retired: fx.config.retired } : {}),
        language: plain ? 'plain' : 'powershell',
      })
      expect(
        g.findings.filter((f) => f.pass !== 2).map((f) => `${f.pass}:${f.reason}:${f.matched}`),
        `guard on sanitized rendering:\n${exampleText}`,
      ).toEqual([])
    })
  }

  it('corpus invariants', () => {
    expect(corpusStats.wrongAuto).toBe(0)
    const recall = corpusStats.expectedSlots === 0 ? 1 : corpusStats.found / corpusStats.expectedSlots
    expect(recall).toBeGreaterThanOrEqual(0.95)
  })
})
