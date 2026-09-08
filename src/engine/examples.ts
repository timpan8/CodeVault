import type { Field, FieldKind } from './types'

/**
 * Example values live in reserved namespaces (RFC 2606 / RFC 5737 and
 * obviously-fake patterns) so a fake can never collide with a real value and
 * the guard can tell them apart by construction.
 */
export interface ExampleNamespace {
  mailDomain: string
  domain: string
  netbios: string
  hostPrefix: string
  pathRoot: string
  tenant: string
  userPrefix: string
  mailUser: string
  passwordWord: string
  /** Marker word; the generic "example" check applies only to the default namespace. */
  word: string
}

export const DEFAULT_NAMESPACE: ExampleNamespace = {
  mailDomain: 'example.com',
  domain: 'corp.example',
  netbios: 'EXAMPLE',
  hostPrefix: 'SRV-EXAMPLE',
  pathRoot: 'C:\\Example',
  tenant: 'example.onmicrosoft.com',
  userPrefix: 'svc-example',
  mailUser: 'anna.exempel',
  passwordWord: 'Ex@mple',
  word: 'example',
}

export const ALTERNATE_NAMESPACES: readonly ExampleNamespace[] = [
  {
    mailDomain: 'exmpl.net',
    domain: 'corp.exmpl',
    netbios: 'EXMPL',
    hostPrefix: 'SRV-EXMPL',
    pathRoot: 'C:\\Exmpl',
    tenant: 'exmpl.onmicrosoft.com',
    userPrefix: 'svc-exmpl',
    mailUser: 'anna.exmpl',
    passwordWord: 'Ex@mpl',
    word: 'exmpl',
  },
  {
    mailDomain: 'sampleorg.test',
    domain: 'corp.sampleorg',
    netbios: 'SAMPLEORG',
    hostPrefix: 'SRV-SAMPLE',
    pathRoot: 'C:\\SampleOrg',
    tenant: 'sampleorg.onmicrosoft.com',
    userPrefix: 'svc-sample',
    mailUser: 'anna.sample',
    passwordWord: 'S@mple',
    word: 'sample',
  },
]

export interface GenerateOptions {
  /** The real value's shape decides e.g. FQDN vs short host, NetBIOS vs DNS domain. */
  shapeOf?: string
  /** AI-visible project name used in path examples. */
  aiVisibleName?: string
}

const pad = (n: number, width: number) => String(n).padStart(width, '0')

export function generateExample(
  kind: FieldKind,
  n: number,
  ns: ExampleNamespace = DEFAULT_NAMESPACE,
  opts: GenerateOptions = {},
): string {
  const shape = opts.shapeOf ?? ''
  switch (kind) {
    case 'email':
      return `${ns.mailUser}${n}@${ns.mailDomain}`
    case 'domain': {
      const looksNetbios = shape !== '' && !shape.includes('.')
      if (looksNetbios) return n === 1 ? ns.netbios : `${ns.netbios}${n}`
      return n === 1 ? ns.domain : ns.domain.replace(/^([^.]+)/, `$1${n}`)
    }
    case 'username': {
      const domainQualified = /^[^\\@]+\\[^\\]+$/.test(shape)
      if (domainQualified) return `${ns.netbios}\\${ns.userPrefix}${pad(n, 2)}`
      return `${ns.userPrefix}${pad(n, 2)}`
    }
    case 'server': {
      const short = shape !== '' && !shape.includes('.')
      return short ? `${ns.hostPrefix}${pad(n, 2)}` : `${ns.hostPrefix}${pad(n, 2)}.${ns.domain}`
    }
    case 'ip':
      return n <= 244 ? `192.0.2.${10 + n}` : `198.51.100.${(n - 244) % 250}`
    case 'tenantId':
      return `11111111-2222-4333-8444-${pad(n, 12)}`
    case 'unc':
      return `\\\\${ns.hostPrefix}${pad(n, 2)}\\Share`
    case 'path': {
      const project = opts.aiVisibleName ?? 'Project01'
      return n === 1 ? `${ns.pathRoot}\\${project}` : `${ns.pathRoot}\\${project}\\Path${pad(n, 2)}`
    }
    case 'password':
      return `${ns.passwordWord}-Passw0rd-${n}`
    case 'apiKey':
      return `${ns.netbios}-KEY-${pad(n, 4)}`
    case 'blob':
      return `${ns.netbios}-BLOCK-${pad(n, 2)}`
    case 'custom':
      return `${ns.netbios}-VALUE-${pad(n, 2)}`
  }
}

/** Smallest n >= 1 whose generated example is not already used by another field. */
export function nextExample(
  kind: FieldKind,
  fields: Iterable<Pick<Field, 'example'>>,
  ns: ExampleNamespace = DEFAULT_NAMESPACE,
  opts: GenerateOptions = {},
): string {
  const used = new Set<string>()
  for (const f of fields) used.add(f.example.toLowerCase())
  for (let n = 1; n < 10_000; n++) {
    const candidate = generateExample(kind, n, ns, opts)
    if (!used.has(candidate.toLowerCase())) return candidate
  }
  throw new Error('example namespace exhausted')
}

const TEST_NET = /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/
const FAKE_GUID = /^11111111-2222-4333-8444-\d{12}$/i

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** True when a value is recognisably inside the tool's fake namespace. */
export function isInExampleNamespace(value: string, ns: ExampleNamespace = DEFAULT_NAMESPACE): boolean {
  const v = value.toLowerCase()
  if (TEST_NET.test(v) || FAKE_GUID.test(v)) return true
  const needles = [
    ns.mailDomain,
    ns.domain,
    ns.hostPrefix,
    ns.pathRoot,
    ns.tenant,
    ns.userPrefix,
    ns.mailUser,
    `${ns.passwordWord}-passw0rd-`,
    `${ns.netbios}-key-`,
    `${ns.netbios}-block-`,
    `${ns.netbios}-value-`,
  ].map((s) => s.toLowerCase())
  if (needles.some((needle) => v.includes(needle))) return true
  const words = ns.word === 'example' ? ['example', 'exempel', ns.netbios.toLowerCase()] : [ns.word, ns.netbios.toLowerCase()]
  return words.some((w) => new RegExp(`(^|[^a-z0-9])${escapeRe(w)}\\d*([^a-z0-9]|$)`).test(v))
}

/**
 * A real value that falls inside the fake namespace disables namespace-based
 * trust; the caller then switches the vault to an alternate namespace.
 */
export function realValueCollidesWithNamespace(realValue: string, ns: ExampleNamespace): boolean {
  return isInExampleNamespace(realValue, ns)
}
