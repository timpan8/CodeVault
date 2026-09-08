/**
 * Tolerant PowerShell lexer. Not a parser: it produces tokens with quote
 * context, logical (unescaped) string values and the nearest binding
 * ($Var =, -Param, hashtable key, JSON key, positional argument) so the engine
 * can match values by meaning and escape them correctly on render.
 *
 * It must never throw. On anything it does not understand it degrades to
 * "no binding information", never to an error.
 */
import type { QuoteKind } from '../types'

export type TokenKind =
  | 'string'
  | 'bareword'
  | 'variable'
  | 'parameter'
  | 'operator'
  | 'comment'
  | 'number'
  | 'punct'
  | 'newline'
  | 'whitespace'
  | 'type'
  | 'keyword'

export type BindingKind = 'assign' | 'param' | 'key' | 'jsonkey' | 'positional'

export interface Binding {
  kind: BindingKind
  /** Variable/parameter/key name without sigils, original casing. */
  name: string
  command?: string
  index?: number
}

export interface Token {
  kind: TokenKind
  start: number
  end: number
  raw: string
  /** 0-based line of the token start. */
  line: number
  quote?: QuoteKind
  /** Unescaped value for strings; raw text for barewords and comments. */
  logical?: string
  contentStart?: number
  contentEnd?: number
  hasSubexpr?: boolean
  unterminated?: boolean
  binding?: Binding
  /** Command of the enclosing pipeline element (e.g. Write-Host). */
  command?: string
  /** Enclosing function name. */
  function?: string
  regexContext?: boolean
  inHashtable?: boolean
}

const OPERATORS = new Set(
  (
    'eq ne gt ge lt le like notlike match notmatch replace contains notcontains in notin and or not xor band bor bxor bnot ' +
    'is isnot as split join f shl shr ' +
    'ceq cne cgt cge clt cle clike cnotlike cmatch cnotmatch creplace ccontains cnotcontains csplit ' +
    'ieq ine igt ige ilt ile ilike inotlike imatch inotmatch ireplace icontains inotcontains isplit'
  )
    .split(' ')
    .map((o) => '-' + o),
)

const REGEX_OPERATORS = new Set(
  ['match', 'notmatch', 'cmatch', 'cnotmatch', 'imatch', 'inotmatch', 'replace', 'creplace', 'ireplace', 'split', 'csplit', 'isplit'].map(
    (o) => '-' + o,
  ),
)

const REGEX_PARAMS = new Set(['pattern', 'regex'])

const SWITCH_PARAMS = new Set([
  'force',
  'recurse',
  'whatif',
  'confirm',
  'verbose',
  'debug',
  'asplaintext',
  'passthru',
  'nonewline',
  'append',
  'notypeinformation',
  'usebasicparsing',
  'allowclobber',
  'disablenameChecking',
  'skipcertificatecheck',
  'noprofile',
  'noninteractive',
  'wait',
  'nowait',
  'quiet',
  'raw',
  'stream',
])

const KEYWORDS = new Set([
  'function',
  'filter',
  'param',
  'if',
  'else',
  'elseif',
  'foreach',
  'for',
  'while',
  'do',
  'switch',
  'try',
  'catch',
  'finally',
  'return',
  'throw',
  'begin',
  'process',
  'end',
  'class',
  'enum',
  'using',
  'workflow',
  'configuration',
  'in',
  'break',
  'continue',
  'exit',
  'dynamicparam',
])

const MAX_MULTILINE_STRING_LINES = 12

function isWs(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v'
}

function countNewlines(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++
  return n
}

export function unescapeSq(content: string): string {
  return content.replace(/''/g, "'")
}

export function unescapeDq(content: string): string {
  let out = ''
  for (let i = 0; i < content.length; i++) {
    const c = content[i]!
    if (c === '`') {
      const next = content[i + 1]
      if (next === '"' || next === '`' || next === '$') {
        out += next
        i++
        continue
      }
      if (next === undefined) {
        out += c
        continue
      }
      // Other escapes (`n, `t, `0, `u{...}) are kept raw: they are not value characters.
      out += c + next
      i++
      continue
    }
    if (c === '"' && content[i + 1] === '"') {
      out += '"'
      i++
      continue
    }
    out += c
  }
  return out
}

export function unescapeHsDq(content: string): string {
  let out = ''
  for (let i = 0; i < content.length; i++) {
    const c = content[i]!
    if (c === '`') {
      const next = content[i + 1]
      if (next === '`' || next === '$') {
        out += next
        i++
        continue
      }
      if (next === undefined) {
        out += c
        continue
      }
      out += c + next
      i++
      continue
    }
    out += c
  }
  return out
}

/** True when a double-quoted body contains an interpolated variable or subexpression. */
export function hasSubexpression(content: string): boolean {
  return /(^|[^`])\$([A-Za-z_(]|\{)/.test(content)
}

interface QuoteScan {
  end: number
  contentEnd: number
  closed: boolean
}

function scanQuoted(text: string, i: number, q: '"' | "'"): QuoteScan {
  const n = text.length
  const attempt = (allowNewlines: number): QuoteScan | null => {
    let j = i + 1
    let newlines = 0
    while (j < n) {
      const ch = text[j]!
      if (q === '"' && ch === '`') {
        j += 2
        continue
      }
      if (ch === q) {
        if (text[j + 1] === q) {
          j += 2
          continue
        }
        return { end: j + 1, contentEnd: j, closed: true }
      }
      if (ch === '\n') {
        newlines++
        if (newlines > allowNewlines) return null
      }
      j++
    }
    return null
  }
  const single = attempt(0)
  if (single) return single
  const multi = attempt(MAX_MULTILINE_STRING_LINES)
  if (multi) return multi
  let eol = text.indexOf('\n', i)
  if (eol < 0) eol = n
  return { end: eol, contentEnd: eol, closed: false }
}

const BAREWORD_STOP = new Set([' ', '\t', '\r', '\n', '\f', '\v', ';', ',', '|', '(', ')', '{', '}', "'", '"', '='])

export function lex(text: string): Token[] {
  const tokens: Token[] = []
  const n = text.length
  let i = 0
  let line = 0

  while (i < n) {
    const c = text[i]!
    const start = i

    if (c === '\n') {
      tokens.push({ kind: 'newline', start, end: i + 1, raw: '\n', line })
      line++
      i++
      continue
    }
    if (isWs(c)) {
      while (i < n && isWs(text[i]!)) i++
      tokens.push({ kind: 'whitespace', start, end: i, raw: text.slice(start, i), line })
      continue
    }
    if (c === '`' && (text[i + 1] === '\n' || (text[i + 1] === '\r' && text[i + 2] === '\n'))) {
      const len = text[i + 1] === '\r' ? 3 : 2
      tokens.push({ kind: 'whitespace', start, end: i + len, raw: text.slice(start, i + len), line })
      line++
      i += len
      continue
    }
    if (c === '<' && text[i + 1] === '#') {
      const close = text.indexOf('#>', i + 2)
      const end = close < 0 ? n : close + 2
      const raw = text.slice(start, end)
      tokens.push({
        kind: 'comment',
        start,
        end,
        raw,
        line,
        quote: 'comment',
        logical: text.slice(start + 2, close < 0 ? n : close),
        contentStart: start + 2,
        contentEnd: close < 0 ? n : close,
      })
      line += countNewlines(raw)
      i = end
      continue
    }
    if (c === '#') {
      let end = text.indexOf('\n', i)
      if (end < 0) end = n
      tokens.push({
        kind: 'comment',
        start,
        end,
        raw: text.slice(start, end),
        line,
        quote: 'comment',
        logical: text.slice(start + 1, end),
        contentStart: start + 1,
        contentEnd: end,
      })
      i = end
      continue
    }
    if (c === '@' && (text[i + 1] === "'" || text[i + 1] === '"')) {
      const q = text[i + 1]!
      let j = i + 2
      if (text[j] === '\r') j++
      if (text[j] === '\n') {
        const contentStart = j + 1
        const closeRe = q === "'" ? /\r?\n'@/g : /\r?\n"@/g
        closeRe.lastIndex = contentStart
        const m = closeRe.exec(text)
        const contentEnd = m ? m.index : n
        const end = m ? m.index + m[0].length : n
        const content = text.slice(contentStart, contentEnd)
        const raw = text.slice(start, end)
        const quote: QuoteKind = q === "'" ? 'hs-sq' : 'hs-dq'
        tokens.push({
          kind: 'string',
          start,
          end,
          raw,
          line,
          quote,
          logical: quote === 'hs-sq' ? content : unescapeHsDq(content),
          contentStart,
          contentEnd,
          hasSubexpr: quote === 'hs-dq' && hasSubexpression(content),
          unterminated: !m,
        })
        line += countNewlines(raw)
        i = end
        continue
      }
    }
    if (c === '@' && (text[i + 1] === '{' || text[i + 1] === '(')) {
      tokens.push({ kind: 'punct', start, end: i + 2, raw: text.slice(i, i + 2), line })
      i += 2
      continue
    }
    if (c === "'" || c === '"') {
      const scan = scanQuoted(text, i, c)
      const content = text.slice(i + 1, scan.contentEnd)
      const raw = text.slice(start, scan.end)
      const quote: QuoteKind = c === "'" ? 'sq' : 'dq'
      tokens.push({
        kind: 'string',
        start,
        end: scan.end,
        raw,
        line,
        quote,
        logical: quote === 'sq' ? unescapeSq(content) : unescapeDq(content),
        contentStart: i + 1,
        contentEnd: scan.contentEnd,
        hasSubexpr: quote === 'dq' && hasSubexpression(content),
        unterminated: !scan.closed,
      })
      line += countNewlines(raw)
      i = scan.end
      continue
    }
    if (c === '$') {
      if (text[i + 1] === '(') {
        tokens.push({ kind: 'punct', start, end: i + 2, raw: '$(', line })
        i += 2
        continue
      }
      let j = i + 1
      if (text[j] === '{') {
        const close = text.indexOf('}', j + 1)
        j = close < 0 ? n : close + 1
      } else if (text[j] !== undefined && /[$?^_]/.test(text[j]!) && !/[A-Za-z0-9_]/.test(text[j + 1] ?? '')) {
        j++
      } else {
        while (j < n && /[A-Za-z0-9_:]/.test(text[j]!)) j++
        // A trailing ':' belongs to the following token (e.g. "$x:" is rare); keep scopes like $env:X.
        if (text[j - 1] === ':' && j - 1 > i + 1) j--
      }
      tokens.push({ kind: 'variable', start, end: j, raw: text.slice(start, j), line })
      i = j
      continue
    }
    if (c === '-' && /[A-Za-z]/.test(text[i + 1] ?? '')) {
      let j = i + 1
      while (j < n && /[A-Za-z0-9_]/.test(text[j]!)) j++
      const word = text.slice(i, j).toLowerCase()
      if (OPERATORS.has(word)) {
        tokens.push({ kind: 'operator', start, end: j, raw: text.slice(start, j), line })
        i = j
        continue
      }
      if (text[j] === ':') j++
      tokens.push({ kind: 'parameter', start, end: j, raw: text.slice(start, j), line })
      i = j
      continue
    }
    if (c === '[') {
      const m = /^\[[A-Za-z_][\w.]*(\[\])*\]/.exec(text.slice(i, i + 200))
      if (m) {
        tokens.push({ kind: 'type', start, end: i + m[0].length, raw: m[0], line })
        i += m[0].length
        continue
      }
      tokens.push({ kind: 'punct', start, end: i + 1, raw: '[', line })
      i++
      continue
    }
    if (c === ':' && text[i + 1] === ':') {
      tokens.push({ kind: 'punct', start, end: i + 2, raw: '::', line })
      i += 2
      continue
    }
    if ('(){}[];,|&:!'.includes(c)) {
      tokens.push({ kind: 'punct', start, end: i + 1, raw: c, line })
      i++
      continue
    }
    if (c === '=' || c === '+' || c === '*' || c === '/' || c === '%') {
      const two = text[i + 1] === '=' ? 2 : c === '+' && text[i + 1] === '+' ? 2 : 1
      tokens.push({ kind: 'operator', start, end: i + two, raw: text.slice(i, i + two), line })
      i += two
      continue
    }
    if (c === '>' || c === '<') {
      const two = text[i + 1] === '>' ? 2 : 1
      tokens.push({ kind: 'operator', start, end: i + two, raw: text.slice(i, i + two), line })
      i += two
      continue
    }
    // Bareword (commands, paths, hostnames, emails, dot-sourcing, member access).
    let j = i
    while (j < n && !BAREWORD_STOP.has(text[j]!)) j++
    if (j === i) j = i + 1
    const raw = text.slice(i, j)
    const lower = raw.toLowerCase()
    const kind: TokenKind = KEYWORDS.has(lower) ? 'keyword' : /^-?\d+(\.\d+)?([kmgtp]b)?$/i.test(raw) ? 'number' : 'bareword'
    tokens.push({
      kind,
      start,
      end: j,
      raw,
      line,
      quote: 'bare',
      logical: raw,
      contentStart: i,
      contentEnd: j,
      hasSubexpr: /\$[\w({]/.test(raw),
    })
    i = j
  }

  annotateBindings(tokens)
  return tokens
}

export function variableName(tok: Token): string {
  let s = tok.raw
  if (s.startsWith('$')) s = s.slice(1)
  if (s.startsWith('{') && s.endsWith('}')) s = s.slice(1, -1)
  return s.replace(/^(script|global|local|private):/i, '')
}

export function parameterName(tok: Token): string {
  let s = tok.raw
  if (s.startsWith('-')) s = s.slice(1)
  if (s.endsWith(':')) s = s.slice(0, -1)
  return s
}

const COMMAND_RE = /^(&|\.)?[A-Za-z_][\w]*-[A-Za-z_][\w]*$|^\.\\|^&/

interface ElementState {
  elem: Token[]
  command: string | undefined
  positional: number
  pendingParam: Token | undefined
  assignName: string | undefined
  keyName: string | undefined
  jsonKey: string | undefined
  lastOperator: Token | undefined
  afterAssign: boolean
  pendingFunctionKeyword: boolean
}

interface Frame {
  open: string
  saved: ElementState
  hashtable: boolean
  fnBefore: string | undefined
  inheritedCommand: string | undefined
}

function freshState(command?: string): ElementState {
  return {
    elem: [],
    command,
    positional: 0,
    pendingParam: undefined,
    assignName: undefined,
    keyName: undefined,
    jsonKey: undefined,
    lastOperator: undefined,
    afterAssign: false,
    pendingFunctionKeyword: false,
  }
}

function annotateBindings(tokens: Token[]): void {
  const stack: Frame[] = []
  let fn: string | undefined
  let pendingFunctionName: string | undefined
  let state = freshState()

  const top = () => stack[stack.length - 1]
  const inHashtable = () => top()?.hashtable === true

  const startElement = () => {
    const frame = top()
    const inherited = frame && (frame.open === '(' || frame.open === '@(') ? frame.inheritedCommand : undefined
    state = freshState(inherited)
  }

  const isValue = (t: Token) => t.kind === 'string' || t.kind === 'bareword' || t.kind === 'number' || t.kind === 'variable'

  for (const t of tokens) {
    if (t.kind === 'whitespace') continue
    t.function = fn
    t.inHashtable = inHashtable()

    if (t.kind === 'newline') {
      const prev = state.elem[state.elem.length - 1]
      const continues =
        prev !== undefined && (prev.kind === 'operator' || (prev.kind === 'punct' && (prev.raw === '|' || prev.raw === ',')))
      const frame = top()
      const parenContinues = frame !== undefined && (frame.open === '(' || frame.open === '[')
      if (!continues && !parenContinues) startElement()
      continue
    }

    if (t.kind === 'punct') {
      switch (t.raw) {
        case '(':
        case '@(':
        case '[':
        case '$(': {
          stack.push({ open: t.raw === '$(' ? '(' : t.raw, saved: state, hashtable: false, fnBefore: fn, inheritedCommand: state.command })
          startElement()
          continue
        }
        case '@{': {
          stack.push({ open: '@{', saved: state, hashtable: true, fnBefore: fn, inheritedCommand: undefined })
          startElement()
          continue
        }
        case '{': {
          stack.push({ open: '{', saved: state, hashtable: false, fnBefore: fn, inheritedCommand: undefined })
          if (pendingFunctionName !== undefined) {
            fn = pendingFunctionName
            pendingFunctionName = undefined
          }
          startElement()
          continue
        }
        case ')':
        case ']':
        case '}': {
          const frame = stack.pop()
          if (frame) {
            state = frame.saved
            // The group was the argument: it consumed any pending parameter.
            state.pendingParam = undefined
            state.lastOperator = undefined
            state.elem.push(t)
            if (frame.open === '{') fn = frame.fnBefore
          } else {
            startElement()
          }
          continue
        }
        case ';':
        case '|': {
          startElement()
          continue
        }
        case ':': {
          const first = state.elem[0]
          if (state.elem.length === 1 && first?.kind === 'string' && state.command === undefined) {
            state.jsonKey = first.logical ?? first.raw
          }
          continue
        }
        case ',': {
          // JSON entries are comma-separated; PowerShell array arguments keep their binding.
          if (state.jsonKey !== undefined) startElement()
          continue
        }
        default:
          continue
      }
    }

    const first = state.elem[0]

    if (state.elem.length === 0) {
      if (t.kind === 'keyword') {
        const kw = t.raw.toLowerCase()
        if (kw === 'function' || kw === 'filter' || kw === 'workflow' || kw === 'configuration') {
          state.pendingFunctionKeyword = true
        }
        state.elem.push(t)
        continue
      }
      if (t.kind === 'bareword') {
        if (state.pendingFunctionKeyword) {
          pendingFunctionName = t.raw
          state.pendingFunctionKeyword = false
        } else if (inHashtable()) {
          // hashtable key; binding decided when '=' arrives
        } else {
          state.command = t.raw
        }
        t.command = state.command
        state.elem.push(t)
        continue
      }
      t.command = state.command
      state.elem.push(t)
      continue
    }

    // First token after 'function Name' may be the parameter list or body; nothing to bind.
    if (state.pendingFunctionKeyword && t.kind === 'bareword') {
      pendingFunctionName = t.raw
      state.pendingFunctionKeyword = false
      state.elem.push(t)
      continue
    }

    if (t.kind === 'operator' && (t.raw === '=' || t.raw === '+=')) {
      const second = state.elem[1]
      if (first?.kind === 'variable' && state.elem.length === 1) state.assignName = variableName(first)
      else if (first?.kind === 'type' && second?.kind === 'variable' && state.elem.length === 2) state.assignName = variableName(second)
      else if (inHashtable() && (first?.kind === 'bareword' || first?.kind === 'string') && state.elem.length === 1) {
        state.keyName = first.logical ?? first.raw
      }
      state.afterAssign = true
      state.command = undefined
      state.positional = 0
      state.elem.push(t)
      continue
    }

    t.command = state.command

    if (t.kind === 'parameter') {
      state.pendingParam = SWITCH_PARAMS.has(parameterName(t).toLowerCase()) ? undefined : t
      state.lastOperator = undefined
      state.elem.push(t)
      continue
    }

    if (t.kind === 'operator') {
      state.lastOperator = t
      state.pendingParam = undefined
      state.elem.push(t)
      continue
    }

    if (t.kind === 'keyword') {
      state.elem.push(t)
      continue
    }

    if (t.kind === 'bareword' && state.afterAssign && state.command === undefined && COMMAND_RE.test(t.raw)) {
      // "$x = Get-Thing -Name 'foo'": the bareword after '=' is a command.
      state.command = t.raw
      state.afterAssign = false
      t.command = state.command
      state.elem.push(t)
      continue
    }

    if (isValue(t)) {
      if (state.assignName !== undefined && state.command === undefined) {
        t.binding = { kind: 'assign', name: state.assignName }
      } else if (state.keyName !== undefined) {
        t.binding = { kind: 'key', name: state.keyName }
      } else if (state.jsonKey !== undefined) {
        t.binding = { kind: 'jsonkey', name: state.jsonKey }
      } else if (state.pendingParam !== undefined) {
        t.binding = { kind: 'param', name: parameterName(state.pendingParam), command: state.command }
        state.pendingParam = undefined
      } else if (state.command !== undefined) {
        t.binding = { kind: 'positional', name: String(state.positional), command: state.command, index: state.positional }
        state.positional++
      }
      const regexByOperator = state.lastOperator !== undefined && REGEX_OPERATORS.has(state.lastOperator.raw.toLowerCase())
      const regexByParam = t.binding?.kind === 'param' && REGEX_PARAMS.has(t.binding.name.toLowerCase())
      if (regexByOperator || regexByParam) t.regexContext = true
      state.lastOperator = undefined
      state.afterAssign = false
      state.elem.push(t)
      continue
    }

    state.elem.push(t)
  }
}

/** Tokens that can carry a value: strings, barewords, numbers and comments. */
export function valueTokens(tokens: readonly Token[]): Token[] {
  return tokens.filter((t) => t.kind === 'string' || t.kind === 'bareword' || t.kind === 'number' || t.kind === 'comment')
}

export function tokenAt(tokens: readonly Token[], offset: number): Token | undefined {
  return tokens.find((t) => t.start <= offset && offset < t.end)
}

/** Generic fallback for non-PowerShell text: same token shape, no bindings. */
export function lexPlain(text: string): Token[] {
  const tokens: Token[] = []
  const n = text.length
  let i = 0
  let line = 0
  while (i < n) {
    const c = text[i]!
    const start = i
    if (c === '\n') {
      tokens.push({ kind: 'newline', start, end: i + 1, raw: '\n', line })
      line++
      i++
      continue
    }
    if (isWs(c)) {
      while (i < n && isWs(text[i]!)) i++
      tokens.push({ kind: 'whitespace', start, end: i, raw: text.slice(start, i), line })
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < n && text[j] !== c && text[j] !== '\n') {
        if (text[j] === '\\') j++
        j++
      }
      const closed = text[j] === c
      const end = closed ? j + 1 : j
      tokens.push({
        kind: 'string',
        start,
        end,
        raw: text.slice(start, end),
        line,
        quote: c === '"' ? 'dq' : 'sq',
        logical: text.slice(i + 1, j),
        contentStart: i + 1,
        contentEnd: j,
        unterminated: !closed,
      })
      i = end
      continue
    }
    let j = i
    while (j < n && !isWs(text[j]!) && text[j] !== '\n' && text[j] !== '"' && text[j] !== "'") j++
    if (j === i) j = i + 1
    tokens.push({
      kind: 'bareword',
      start,
      end: j,
      raw: text.slice(i, j),
      line,
      quote: 'bare',
      logical: text.slice(i, j),
      contentStart: i,
      contentEnd: j,
    })
    i = j
  }
  return tokens
}

/**
 * Map a logical (unescaped) index inside a string/bareword/comment token to
 * the absolute raw offset in the source text. Needed to place slots on raw
 * spans when a match was found on the logical value.
 */
export function logicalToRawOffset(tok: Token, logicalIndex: number, text: string): number {
  const cs = tok.contentStart ?? tok.start
  const ce = tok.contentEnd ?? tok.end
  const quote = tok.quote
  if (quote === 'sq') {
    let logical = 0
    let i = cs
    while (i < ce && logical < logicalIndex) {
      if (text[i] === "'" && text[i + 1] === "'") i += 2
      else i++
      logical++
    }
    return i
  }
  if (quote === 'dq' || quote === 'hs-dq') {
    let logical = 0
    let i = cs
    while (i < ce && logical < logicalIndex) {
      const c = text[i]
      if (c === '`') {
        const next = text[i + 1]
        const single = quote === 'dq' ? next === '"' || next === '`' || next === '$' : next === '`' || next === '$'
        if (single) {
          i += 2
          logical += 1
        } else {
          // kept raw: two logical chars for two raw chars
          const remaining = logicalIndex - logical
          if (remaining >= 2) {
            i += 2
            logical += 2
          } else {
            i += 1
            logical += 1
          }
        }
        continue
      }
      if (quote === 'dq' && c === '"' && text[i + 1] === '"') {
        i += 2
        logical += 1
        continue
      }
      i++
      logical++
    }
    return i
  }
  return cs + logicalIndex
}

export function rawSpanForLogicalRange(tok: Token, logicalStart: number, logicalEnd: number, text: string): { start: number; end: number } {
  return { start: logicalToRawOffset(tok, logicalStart, text), end: logicalToRawOffset(tok, logicalEnd, text) }
}
