/**
 * Table-shaped blocks ("blob" fields): the MVP stop-gap for test data. The
 * whole block becomes one field whose example is a two-row synthetic block
 * with the same keys, so the AI sees the shape but never the rows.
 */
import { DEFAULT_NAMESPACE, type ExampleNamespace } from './examples'

export interface BlobShape {
  kind: 'hashtables' | 'csv' | 'unknown'
  columns: string[]
  rows: number
  delimiter?: string
}

const KEY_RE = /(?:^|[{;\n])\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][\w-]*))\s*=/g

export function analyzeBlock(raw: string): BlobShape {
  const trimmed = raw.trim()
  if (/^@['"]/.test(trimmed)) {
    const body = trimmed.replace(/^@['"]\r?\n/, '').replace(/\r?\n['"]@[\s\S]*$/, '')
    const lines = body.split('\n').filter((l) => l.trim() !== '')
    for (const delimiter of [';', ',', '\t', '|']) {
      const counts = lines.map((l) => l.split(delimiter).length - 1)
      if (lines.length >= 2 && counts[0]! >= 1 && counts.every((c) => c === counts[0])) {
        return { kind: 'csv', columns: lines[0]!.split(delimiter).map((c) => c.trim()), rows: lines.length - 1, delimiter }
      }
    }
    return { kind: 'unknown', columns: [], rows: lines.length }
  }
  const tables = trimmed.match(/@\{/g)?.length ?? 0
  if (tables > 0) {
    const first = /@\{([\s\S]*?)\}/.exec(trimmed)
    const columns: string[] = []
    if (first) {
      for (const m of first[1]!.matchAll(KEY_RE)) {
        const key = m[1] ?? m[2] ?? m[3]
        if (key && !columns.includes(key)) columns.push(key)
      }
    }
    return { kind: 'hashtables', columns, rows: tables }
  }
  return { kind: 'unknown', columns: [], rows: trimmed.split('\n').length }
}

const pad2 = (n: number) => String(n).padStart(2, '0')

export function blobMarker(n: number, ns: ExampleNamespace = DEFAULT_NAMESPACE): string {
  return `${ns.netbios}-BLOCK-${pad2(n)}`
}

function exampleCell(column: string, row: number, ns: ExampleNamespace): string {
  const c = column.toLowerCase()
  if (/mail|upn|userprincipal/.test(c)) return `${ns.mailUser}${row}@${ns.mailDomain}`
  if (/pass|pwd|secret/.test(c)) return `${ns.passwordWord}-Passw0rd-${row}`
  if (/sam|user(name)?$|login|account/.test(c)) return `${ns.userPrefix}${pad2(row)}`
  if (/phone|mobile|tel/.test(c)) return `+46 70 000 00 0${row}`
  return `${column}-example${row}`
}

/** Two synthetic rows with the same keys plus a marker comment; never the real rows. */
export function buildBlobExample(raw: string, n: number, ns: ExampleNamespace = DEFAULT_NAMESPACE): string {
  const shape = analyzeBlock(raw)
  const marker = blobMarker(n, ns)
  const more = Math.max(0, shape.rows - 2)
  const tail = `# ${marker}: ${shape.rows} rows in the real data${more > 0 ? ` (${more} more)` : ''}, same columns`
  if (shape.kind === 'hashtables' && shape.columns.length > 0) {
    const row = (i: number) => `    @{ ${shape.columns.map((c) => `${c} = '${exampleCell(c, i, ns)}'`).join('; ')} }`
    return `@(\n${row(1)},\n${row(2)}\n) ${tail}`
  }
  if (shape.kind === 'csv' && shape.columns.length > 0) {
    const d = shape.delimiter ?? ';'
    const row = (i: number) => shape.columns.map((c) => exampleCell(c, i, ns)).join(d)
    return `@'\n${shape.columns.join(d)}\n${row(1)}\n${row(2)}\n'@ ${tail}`
  }
  return `<# ${marker}: ${shape.rows} lines of data omitted, same structure #>`
}
