import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { lex, lexPlain, logicalToRawOffset, type Token } from '@engine/lexer/powershell'

const strings = (text: string) => lex(text).filter((t) => t.kind === 'string')
const firstString = (text: string): Token => {
  const s = strings(text)[0]
  if (!s) throw new Error('no string token in ' + text)
  return s
}

describe('powershell lexer: strings', () => {
  it('single-quoted with doubled quote', () => {
    const t = firstString("$x = 'it''s'")
    expect(t.quote).toBe('sq')
    expect(t.logical).toBe("it's")
    expect(t.raw).toBe("'it''s'")
  })

  it('double-quoted with backtick escapes and ""', () => {
    const t = firstString('$x = "Pa`$`$w0rd`"x""y"')
    expect(t.quote).toBe('dq')
    expect(t.logical).toBe('Pa$$w0rd"x"y')
    expect(t.hasSubexpr).toBe(false)
  })

  it('double-quoted detects interpolation', () => {
    expect(firstString('"$Server\\share"').hasSubexpr).toBe(true)
    expect(firstString('"`$notavar"').hasSubexpr).toBe(false)
    expect(firstString('"$(Get-Date)"').hasSubexpr).toBe(true)
  })

  it('here-strings', () => {
    const sq = firstString("$a = @'\nline1 $x\n'@\n")
    expect(sq.quote).toBe('hs-sq')
    expect(sq.logical).toBe('line1 $x')
    const dq = firstString('$a = @"\nline `$x `` end\n"@')
    expect(dq.quote).toBe('hs-dq')
    expect(dq.logical).toBe('line $x ` end')
  })

  it('unterminated string stops at end of line and never throws', () => {
    const toks = lex("$x = 'oops\n$y = 1")
    const s = toks.filter((t) => t.kind === 'string')
    expect(s).toHaveLength(1)
    expect(s[0]!.unterminated).toBe(true)
    expect(toks.some((t) => t.kind === 'variable' && t.raw === '$y')).toBe(true)
  })

  it('multi-line string within limit is one token', () => {
    const t = firstString("$x = 'a\nb'")
    expect(t.logical).toBe('a\nb')
    expect(t.unterminated).toBe(false)
  })
})

describe('powershell lexer: comments, variables, parameters', () => {
  it('line and block comments', () => {
    const toks = lex('# top\nGet-Item x <# block\nmore #> -Force # tail')
    const comments = toks.filter((t) => t.kind === 'comment')
    expect(comments.map((c) => c.logical)).toEqual([' top', ' block\nmore ', ' tail'])
  })

  it('hash inside a bareword is not a comment', () => {
    const toks = lex('Get-Item Item#1')
    expect(toks.filter((t) => t.kind === 'comment')).toHaveLength(0)
    expect(toks.find((t) => t.kind === 'bareword' && t.raw === 'Item#1')).toBeTruthy()
  })

  it('variables including scopes and braces', () => {
    const toks = lex('$script:Name = ${my var} + $env:TEMP + $_ + $$')
    const vars = toks.filter((t) => t.kind === 'variable').map((t) => t.raw)
    expect(vars).toEqual(['$script:Name', '${my var}', '$env:TEMP', '$_', '$$'])
  })

  it('parameters vs operators', () => {
    const toks = lex("Get-ADUser -Identity 'x' | Where-Object { $_.Name -match 'a' } -Path:'y'")
    expect(toks.filter((t) => t.kind === 'parameter').map((t) => t.raw)).toEqual(['-Identity', '-Path:'])
    expect(toks.filter((t) => t.kind === 'operator').map((t) => t.raw)).toEqual(['-match'])
  })

  it('type literals', () => {
    const toks = lex('[string]$Name = [System.IO.Path]::Combine($a, $b)')
    expect(toks.filter((t) => t.kind === 'type').map((t) => t.raw)).toEqual(['[string]', '[System.IO.Path]'])
  })
})

describe('powershell lexer: bindings', () => {
  it('assignment', () => {
    const t = firstString("$Username = 'svc-example01'")
    expect(t.binding).toEqual({ kind: 'assign', name: 'Username' })
  })

  it('typed param default', () => {
    const t = firstString("param([string]$Server = 'srv01')")
    expect(t.binding).toEqual({ kind: 'assign', name: 'Server' })
  })

  it('parameter binding with command', () => {
    const t = firstString("Get-ADUser -Identity 'jdoe' -Server 'dc01'")
    expect(t.binding).toEqual({ kind: 'param', name: 'Identity', command: 'Get-ADUser' })
    expect(strings("Get-ADUser -Identity 'jdoe' -Server 'dc01'")[1]!.binding?.name).toBe('Server')
  })

  it('switch parameter does not swallow the next positional', () => {
    const t = firstString("Remove-Item -Force 'C:\\x'")
    expect(t.binding).toEqual({ kind: 'positional', name: '0', command: 'Remove-Item', index: 0 })
  })

  it('hashtable keys', () => {
    const toks = strings("$cfg = @{ User = 'a'; Password = 'b'\n Server='c' }")
    expect(toks.map((t) => t.binding?.name)).toEqual(['User', 'Password', 'Server'])
    expect(toks[0]!.binding?.kind).toBe('key')
    expect(toks[0]!.inHashtable).toBe(true)
  })

  it('json keys', () => {
    const toks = strings('{ "password": "secret", "host": "h" }')
    expect(toks.filter((t) => t.binding).map((t) => [t.binding!.kind, t.binding!.name, t.logical])).toEqual([
      ['jsonkey', 'password', 'secret'],
      ['jsonkey', 'host', 'h'],
    ])
  })

  it('assignment from a command binds to the command parameters', () => {
    const t = firstString("$cred = Get-Credential -UserName 'admin'")
    expect(t.binding).toEqual({ kind: 'param', name: 'UserName', command: 'Get-Credential' })
  })

  it('command of the enclosing element and function name', () => {
    const t = firstString("function Get-Foo {\n  Write-Host 'pw' \n}")
    expect(t.command).toBe('Write-Host')
    expect(t.function).toBe('Get-Foo')
    const after = strings("function Get-Foo { 'a' }\n'b'")[1]!
    expect(after.function).toBeUndefined()
  })

  it('parenthesised argument inherits the command', () => {
    const t = firstString("Write-Host ('pw: ' + $p)")
    expect(t.command).toBe('Write-Host')
  })

  it('regex context by operator and by -Pattern', () => {
    expect(firstString("$x -match 'a.b'").regexContext).toBe(true)
    expect(firstString("Select-String -Pattern 'a.b' -Path x").regexContext).toBe(true)
    expect(firstString("$x -eq 'a.b'").regexContext).toBeUndefined()
  })

  it('pipeline elements reset the command', () => {
    const toks = strings("Get-Item 'a' | Out-File 'b'")
    expect(toks[0]!.binding?.command).toBe('Get-Item')
    expect(toks[1]!.binding?.command).toBe('Out-File')
  })

  it('never throws on arbitrary input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (s) => {
        const toks = lex(s)
        let pos = 0
        for (const t of toks) {
          expect(t.start).toBe(pos)
          pos = t.end
        }
        expect(pos).toBe(s.length)
      }),
      { numRuns: 300 },
    )
  })
})

describe('logicalToRawOffset', () => {
  it('maps through sq escapes', () => {
    const text = "'ab''cd'"
    const t = firstString(text)
    expect(logicalToRawOffset(t, 0, text)).toBe(1)
    expect(logicalToRawOffset(t, 3, text)).toBe(5) // after ab' -> raw index of c
    expect(text.slice(logicalToRawOffset(t, 3, text), logicalToRawOffset(t, 5, text))).toBe('cd')
  })

  it('maps through dq backtick escapes', () => {
    const text = '"x`$y`"z"'
    const t = firstString(text)
    expect(t.logical).toBe('x$y"z')
    const s = logicalToRawOffset(t, 1, text)
    const e = logicalToRawOffset(t, 3, text)
    expect(text.slice(s, e)).toBe('`$y')
  })
})

describe('plain lexer', () => {
  it('splits quoted strings and barewords', () => {
    const toks = lexPlain('export PASS="a b" host=srv01')
    expect(toks.filter((t) => t.kind === 'string')[0]!.logical).toBe('a b')
    expect(toks.filter((t) => t.kind === 'bareword').map((t) => t.raw)).toEqual(['export', 'PASS=', 'host=srv01'])
  })
})
