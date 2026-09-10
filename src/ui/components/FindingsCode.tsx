import { useEffect, useRef } from 'preact/hooks'
import { EditorState, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, lineNumbers, type DecorationSet } from '@codemirror/view'
import { StreamLanguage, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { powerShell } from '@codemirror/legacy-modes/mode/powershell'
import { redactSpans, type Finding } from '../findings'

/**
 * Read-only view of the paste being reviewed, with every finding marked and the
 * selected one picked out. Not the same thing as Editor: that renders the
 * example rendering of a stored version, its slots are replace-decoration pills
 * with a field behind each, and its copy path runs the leak guard. Here the
 * document is the user's own raw paste, findings are marks over text that stays
 * put, and copying is off — there is nothing safe to hand out from it.
 *
 * Secrets are redacted before the state is built, never hidden by a decoration:
 * a replace widget leaves the text in the document, where sliceDoc and toJSON
 * still reach it (invariant 6). There is no undo history to leak through either,
 * because no history() extension is added.
 */

const setMarks = StateEffect.define<readonly Finding[]>()
/** The range travels with the effect: a field must not read another mid-update. */
const setActive = StateEffect.define<{ from: number; to: number } | null>()

const TONE: Record<Finding['status'], string> = {
  auto: 'cv-find-auto',
  confirm: 'cv-find-confirm',
  candidate: 'cv-find-candidate',
  unknown: 'cv-find-unknown',
  rejected: 'cv-find-rejected',
}

function marksToDeco(marks: readonly Finding[]): DecorationSet {
  return Decoration.set(
    marks.map((f) =>
      Decoration.mark({ class: `cv-find ${TONE[f.status]}${f.masked ? ' cv-find-masked' : ''}`, attributes: { 'data-find': f.id } }).range(f.from, f.to),
    ),
    true,
  )
}

/** All findings. Its own field so stepping never recomputes the larger set. */
const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) if (e.is(setMarks)) return marksToDeco(e.value)
    return deco.map(tr.changes)
  },
  provide: (f) => EditorView.decorations.from(f),
})

/** Just the selected finding, so a step never recomputes the larger set. */
const activeField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (!e.is(setActive)) continue
      return e.value === null ? Decoration.none : Decoration.set([Decoration.mark({ class: 'cv-find-active' }).range(e.value.from, e.value.to)])
    }
    return deco.map(tr.changes)
  },
  provide: (f) => EditorView.decorations.from(f),
})

function rangeOf(marks: readonly Finding[], id: string | null): { from: number; to: number } | null {
  if (id === null) return null
  const f = marks.find((m) => m.id === id)
  return f ? { from: f.from, to: f.to } : null
}

export interface FindingsCodeProps {
  /** The raw paste. Masked spans are redacted before the document is built. */
  text: string
  marks: readonly Finding[]
  activeId: string | null
  language: 'powershell' | 'plain'
  onSelect: (id: string) => void
  /** Shown when the user tries to copy out of the pane. */
  onCopyBlocked?: () => void
}

export function FindingsCode(props: FindingsCodeProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const latest = useRef(props)
  latest.current = props

  // The document changes only with the paste or the language. Everything else
  // is a dispatch, so stepping between findings keeps the scroll position.
  useEffect(() => {
    if (!host.current) return
    const extensions = [
      lineNumbers(),
      EditorView.lineWrapping,
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      marksField,
      activeField,
      EditorView.domEventHandlers({
        mousedown: (e, v) => {
          const pos = v.posAtCoords({ x: e.clientX, y: e.clientY })
          if (pos === null) return false
          const hit = latest.current.marks.find((f) => pos >= f.from && pos <= f.to)
          if (!hit) return false
          latest.current.onSelect(hit.id)
          return false
        },
        copy: (e) => {
          e.preventDefault()
          latest.current.onCopyBlocked?.()
          return true
        },
        cut: (e) => {
          e.preventDefault()
          latest.current.onCopyBlocked?.()
          return true
        },
        contextmenu: (e) => {
          e.preventDefault()
          return true
        },
        dragstart: (e) => {
          e.preventDefault()
          return true
        },
      }),
      EditorView.theme({
        '&': { fontFamily: 'var(--cv-mono)', fontSize: '13px' },
        '.cm-scroller': { fontFamily: 'var(--cv-mono)', overflow: 'auto' },
        '.cm-content': { caretColor: 'transparent' },
        '&.cm-focused': { outline: 'none' },
      }),
    ]
    if (props.language === 'powershell') extensions.push(StreamLanguage.define(powerShell))
    const doc = redactSpans(props.text, props.marks.filter((f) => f.masked))
    const state = EditorState.create({ doc, extensions })
    if (view.current) view.current.setState(state)
    else view.current = new EditorView({ state, parent: host.current })
    view.current.dispatch({ effects: [setMarks.of(props.marks), setActive.of(rangeOf(props.marks, props.activeId))] })
  }, [props.text, props.language])

  // A row can turn into a password after the fact (the user creates the field),
  // so the redaction is re-applied as a length-preserving change: readOnly stops
  // the user typing, not a programmatic dispatch, and every offset survives.
  useEffect(() => {
    const v = view.current
    if (!v) return
    const wanted = redactSpans(props.text, props.marks.filter((f) => f.masked))
    if (wanted !== v.state.doc.toString()) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: wanted } })
    }
    v.dispatch({ effects: [setMarks.of(props.marks), setActive.of(rangeOf(props.marks, latest.current.activeId))] })
  }, [props.marks])

  useEffect(() => {
    const v = view.current
    if (!v) return
    const target = rangeOf(props.marks, props.activeId)
    const effects: StateEffect<unknown>[] = [setActive.of(target)]
    if (target) effects.push(EditorView.scrollIntoView(target.from, { y: 'center' }))
    v.dispatch({ effects })
  }, [props.activeId])

  useEffect(
    () => () => {
      view.current?.destroy()
      view.current = null
    },
    [],
  )

  return <div class="cv-review-code" ref={host} onContextMenu={(e) => e.preventDefault()} />
}
