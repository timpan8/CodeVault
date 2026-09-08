import { useEffect, useRef } from 'preact/hooks'
import { EditorState } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, lineNumbers } from '@codemirror/view'
import { StreamLanguage, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { powerShell } from '@codemirror/legacy-modes/mode/powershell'
import type { Field } from '@engine/types'
import type { SlotLayout } from '../layout'

/**
 * Read-only CodeMirror view of the sanitized rendering. Every slot is a pill
 * (replace decoration). Copy/cut hand the selection to the caller so the
 * guard can run; context menu and drag are blocked so a revealed value can
 * never be lifted by "Ask Copilot", search-on-selection or a drop target.
 */
class PillWidget extends WidgetType {
  constructor(
    readonly slot: SlotLayout,
    readonly field: Field | undefined,
    readonly label: string,
    readonly onClick: (slot: SlotLayout, el: HTMLElement) => void,
  ) {
    super()
  }

  override eq(other: PillWidget): boolean {
    return other.slot.fieldId === this.slot.fieldId && other.slot.status === this.slot.status && other.slot.from === this.slot.from && other.label === this.label
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span')
    const kind = this.field?.kind ?? 'unknown'
    el.className = `cv-pill cv-pill-${this.slot.status} cv-kind-${kind}${this.slot.missingField ? ' cv-pill-missing' : ''}`
    el.setAttribute('role', 'button')
    el.setAttribute('aria-label', `${this.field?.name ?? '?'} (${kind})`)
    const ex = document.createElement('span')
    ex.className = 'cv-pill-ex'
    ex.textContent = this.label
    const badge = document.createElement('span')
    badge.className = 'cv-pill-kind'
    badge.textContent = this.field?.name ?? '?'
    el.append(ex, badge)
    el.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.onClick(this.slot, el)
    })
    return el
  }

  override ignoreEvent(): boolean {
    return true
  }
}

export interface EditorProps {
  text: string
  slots: SlotLayout[]
  fields: ReadonlyMap<string, Field>
  language: 'powershell' | 'plain'
  onSelectionChange?: (from: number, to: number) => void
  onPillClick?: (slot: SlotLayout, el: HTMLElement) => void
  /** Return the text to put on the clipboard, or null to block the copy. */
  onCopyText?: (selected: string) => string | null
}

export function Editor(props: EditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const latest = useRef(props)
  latest.current = props

  useEffect(() => {
    if (!host.current) return
    const decorations = Decoration.set(
      props.slots.map((s) =>
        Decoration.replace({
          widget: new PillWidget(s, props.fields.get(s.fieldId), props.text.slice(s.from, s.to), (slot, el) => latest.current.onPillClick?.(slot, el)),
        }).range(s.from, s.to),
      ),
      true,
    )
    const extensions = [
      lineNumbers(),
      EditorView.lineWrapping,
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      EditorView.decorations.of(decorations),
      EditorView.updateListener.of((u) => {
        if (u.selectionSet) latest.current.onSelectionChange?.(u.state.selection.main.from, u.state.selection.main.to)
      }),
      EditorView.domEventHandlers({
        copy: (e, v) => handleCopy(e, v),
        cut: (e, v) => handleCopy(e, v),
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
        '&': { fontFamily: 'var(--cv-mono)', fontSize: '13px', height: '100%' },
        '.cm-scroller': { fontFamily: 'var(--cv-mono)', overflow: 'auto' },
        '.cm-content': { caretColor: 'transparent' },
        '&.cm-focused': { outline: 'none' },
      }),
    ]
    if (props.language === 'powershell') extensions.push(StreamLanguage.define(powerShell))
    const state = EditorState.create({ doc: props.text, extensions })
    if (view.current) view.current.setState(state)
    else view.current = new EditorView({ state, parent: host.current })
  }, [props.text, props.slots, props.fields, props.language])

  useEffect(
    () => () => {
      view.current?.destroy()
      view.current = null
    },
    [],
  )

  const handleCopy = (e: ClipboardEvent, v: EditorView): boolean => {
    const { from, to } = v.state.selection.main
    const selected = v.state.sliceDoc(from, to)
    e.preventDefault()
    if (!selected) return true
    const out = latest.current.onCopyText ? latest.current.onCopyText(selected) : selected
    if (out === null) return true
    e.clipboardData?.setData('text/plain', out)
    return true
  }

  return <div class="cv-editor" ref={host} onContextMenu={(e) => e.preventDefault()} />
}
