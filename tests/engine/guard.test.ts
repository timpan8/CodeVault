import { describe, expect, it } from 'vitest'
import { guard, guardShortText } from '@engine/guard'
import { base64Utf16le, base64Utf8 } from '@engine/encoding'
import { createField } from '@engine/fields'
import type { Field } from '@engine/types'

const NOW = '2026-01-01T00:00:00.000Z'
const mk = (id: string, kind: Field['kind'], example: string): Field =>
  createField({ id, name: id.toUpperCase(), kind, example, now: NOW })

const fields = [
  mk('user', 'username', 'svc-example01'),
  mk('pw', 'password', 'Ex@mple-Passw0rd-1'),
  mk('mail', 'email', 'anna.exempel1@example.com'),
  mk('srv', 'server', 'SRV-EXAMPLE01.corp.example'),
  mk('tp', 'username', 'svc-example02'),
]
const real = new Map([
  ['user', 'svc-adsync'],
  ['pw', 'Pa$$w0rd"x'],
  ['mail', 'anna.svensson@corp.contoso.se'],
  ['srv', 'dc01.corp.contoso.se'],
  ['tp', 'tp'],
])

const run = (text: string, extra: Partial<Parameters<typeof guard>[0]> = {}) => guard({ text, fields, real, now: NOW, ...extra })
const pass1 = (text: string, extra?: Partial<Parameters<typeof guard>[0]>) => run(text, extra).findings.filter((f) => f.pass === 1)
const pass2 = (text: string, extra?: Partial<Parameters<typeof guard>[0]>) => run(text, extra).findings.filter((f) => f.pass === 2)

describe('guard pass 1: real values in every form', () => {
  it('plain and case-insensitive for ci kinds, exact for secrets', () => {
    expect(pass1("$u = 'SVC-ADSYNC'").map((f) => f.fieldId)).toEqual(['user'])
    expect(pass1("$p = 'pa$$w0rd\"x'")).toEqual([])
    expect(pass1("$p = 'Pa$$w0rd\"x'").map((f) => f.fieldId)).toEqual(['pw'])
  })

  it('encoded variants: base64 utf-8/utf-16le, url, backtick-escaped', () => {
    expect(pass1(`$b = '${base64Utf8('Pa$$w0rd"x')}'`).map((f) => f.variant)).toContain('encoded')
    expect(pass1(`$b = '${base64Utf16le('Pa$$w0rd"x')}'`).map((f) => f.variant)).toContain('encoded')
    expect(pass1(`$u = "${encodeURIComponent('Pa$$w0rd"x')}"`).map((f) => f.fieldId)).toContain('pw')
    expect(pass1('$p = "Pa`$`$w0rd`"x"').map((f) => f.fieldId)).toContain('pw')
  })

  it('derived domain suffix from email and server reals', () => {
    const f = pass1("Connect-Thing -Server 'fs02.corp.contoso.se'")
    expect(f.map((x) => x.variant)).toContain('domain-suffix')
    expect(f[0]!.matched).toBe('corp.contoso.se')
  })

  it('retired values are found forever', () => {
    const f = pass1("$p = 'Vinter2023!'", { retired: [{ fieldId: 'pw', value: 'Vinter2023!' }] })
    expect(f.map((x) => x.variant)).toEqual(['retired'])
  })

  it('decodes base64 runs and finds the real value inside (EncodedCommand)', () => {
    const enc = base64Utf16le("$p = 'Pa$$w0rd\"x'; Connect-X -Password $p")
    const f = pass1(`powershell.exe -EncodedCommand ${enc}`)
    expect(f.map((x) => x.variant)).toContain('decoded-base64')
    expect(f.find((x) => x.variant === 'decoded-base64')!.fieldId).toBe('pw')
  })

  it('values shorter than 4 chars are never scanned by value', () => {
    expect(pass1("Stop-Process -Name tp\n$x = 'tp'")).toEqual([])
  })

  it('4-7 char values only as whole tokens', () => {
    const fs = [mk('short', 'username', 'svc-example03')]
    const r = new Map([['short', 'jdoe']])
    expect(guard({ text: "$u = 'jdoe'", fields: fs, real: r }).findings.map((f) => f.fieldId)).toEqual(['short'])
    expect(guard({ text: "$u = 'CORP\\jdoe'", fields: fs, real: r }).findings.map((f) => f.fieldId)).toEqual(['short'])
    expect(guard({ text: "$u = 'jdoe-admin'", fields: fs, real: r }).findings.filter((f) => f.pass === 1)).toEqual([])
  })

  it('allowlist never silences pass 1', () => {
    const f = pass1("$u = 'svc-adsync'", { allowlist: [{ value: 'svc-adsync' }] })
    expect(f).toHaveLength(1)
  })
})

describe('guard pass 2: structural detectors', () => {
  it('flags identifying shapes outside the example namespace', () => {
    const text = [
      "$ip = '10.1.2.3'",
      "$share = '\\\\fs01\\it$'",
      "$mail = 'bob@contoso.com'",
      "$t = '3f2a9b1c-1234-4abc-9def-123456789abc'",
      "$jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'",
      "$pnr = '811228-9874'",
      "$cs = 'Server=sql01;Database=x;User Id=sa;Password=Hemligt123;'",
      "Connect-Thing -Server 'dc02.corp.local'",
      "$sec = ConvertTo-SecureString 'Sommar2024!' -AsPlainText -Force",
      "$blob = 'Q7fL9zX2mP4vB8nR1sT6wY3kJ0hG5dA'",
    ].join('\n')
    const reasons = pass2(text).map((f) => f.reason)
    expect(reasons).toContain('IP address outside TEST-NET')
    expect(reasons).toContain('UNC path')
    expect(reasons).toContain('email address')
    expect(reasons).toContain('GUID outside the example pattern')
    expect(reasons).toContain('JWT token')
    expect(reasons).toContain('Swedish personnummer')
    expect(reasons).toContain('password inside connection string')
    expect(reasons).toContain('literal argument to -Server')
    expect(reasons).toContain('plaintext literal to ConvertTo-SecureString')
    expect(reasons).toContain('high-entropy string')
  })

  it('example-namespaced values and ordinary code produce nothing', () => {
    const text = [
      "$u = 'svc-example01'",
      "$mail = 'anna.exempel1@example.com'",
      "$ip = '192.0.2.11'",
      "$t = '11111111-2222-4333-8444-000000000001'",
      "Connect-Thing -Server 'SRV-EXAMPLE01.corp.example'",
      "Import-Module Microsoft.Graph.Users",
      "Export-Csv -Path 'C:\\Example\\Project01\\users.csv' -NoTypeInformation",
      "Get-ADUser -Filter * -Properties DisplayName | Select-Object Name",
      '$ErrorActionPreference = "Stop"',
    ].join('\n')
    expect(run(text).findings).toEqual([])
  })

  it('allowlist suppresses pass 2 unless expired', () => {
    const text = "$ip = '10.1.2.3'"
    expect(pass2(text, { allowlist: [{ value: '10.1.2.3' }] })).toEqual([])
    expect(pass2(text, { allowlist: [{ value: '10.1.2.3', expiresAt: '2025-01-01T00:00:00.000Z' }] })).toHaveLength(1)
  })

  it('emails and UNC paths inside comments are found', () => {
    const reasons = pass2('# ask bob@contoso.com, files on \\\\fs01\\share').map((f) => f.reason)
    expect(reasons).toEqual(['email address', 'UNC path'])
  })

  it('user profile paths are flagged, plain temp paths are not', () => {
    expect(pass2("$p = 'C:\\Users\\tim.pan\\Documents'").map((f) => f.reason)).toEqual(['user profile path'])
    expect(pass2("$p = 'C:\\Temp\\Proj\\out.csv'")).toEqual([])
  })
})

describe('guard pass 3 and helpers', () => {
  it('residual markers and field-name tokens block', () => {
    const f = run('$x = ⟦f:pw|sq⟧ and [PW]').findings.filter((x) => x.pass === 3)
    expect(f.map((x) => x.matched)).toEqual(['⟦f:pw|sq⟧', '[PW]'])
  })

  it('guardShortText scans titles and notes', () => {
    expect(guardShortText('kör mot Volvo-tenanten 3f2a9b1c-1234-4abc-9def-123456789abc', { fields, real }).blocked).toBe(true)
    expect(guardShortText('AD user export', { fields, real }).blocked).toBe(false)
  })

  it('blocked reflects any finding', () => {
    expect(run("$u = 'svc-adsync'").blocked).toBe(true)
    expect(run("$u = 'svc-example01'").blocked).toBe(false)
  })
})
