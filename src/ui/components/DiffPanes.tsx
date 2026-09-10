import { useEffect, useRef } from 'preact/hooks'
import { EditorState } from '@codemirror/state'
import { Decoration, EditorView, GutterMarker, MatchDecorator, ViewPlugin, gutter, lineNumbers, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { MergeView, unifiedMergeView } from '@codemirror/merge'
import { MARKER_RE } from '../diff'
import { t } from '@i18n/index'

/**
 * Two documents side by side or unified. Presentational only: it takes strings,
 * so both a stored-version diff and a not-yet-saved one can use it, and neither
 * ScriptRecord nor the session is anywhere near it.
 */

const markerDecorator = new MatchDecorator({
  regexp: new RegExp(MARKER_RE.source, 'g'),
  decoration: Decoration.mark({ class: 'cv-diff-pill' }),
})

const markerPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = markerDecorator.createDeco(view)
    }
    update(u: ViewUpdate) {
      this.decorations = markerDecorator.updateDeco(u, this.decorations)
    }
  },
  { decorations: (v) => v.decorations },
)

class KeyMarker extends GutterMarker {
  override toDOM(): Node {
    const el = document.createElement('span')
    el.className = 'cv-key-marker'
    el.title = 'field re-applied here'
    el.textContent = '🔑'
    return el
  }
}
const keyMarker = new KeyMarker()
const keyGutter = gutter({
  class: 'cv-key-gutter',
  lineMarker(view, line) {
    return view.state.doc.sliceString(line.from, line.to).includes('⟦') ? keyMarker : null
  },
})

export interface DiffOptions {
  unified: boolean
  collapse: boolean
  wrap: boolean
}

export const defaultDiffOptions: DiffOptions = { unified: false, collapse: true, wrap: true }

/** The three view toggles, controlled by whoever owns the options. */
export function DiffOptionControls(props: { value: DiffOptions; onChange: (o: DiffOptions) => void }) {
  const set = (patch: Partial<DiffOptions>) => props.onChange({ ...props.value, ...patch })
  return (
    <>
      <label class="cv-check">
        <input type="checkbox" checked={props.value.unified} onChange={() => set({ unified: !props.value.unified })} /> {t('diff.unified')}
      </label>
      <label class="cv-check">
        <input type="checkbox" checked={props.value.collapse} onChange={() => set({ collapse: !props.value.collapse })} /> {t('diff.collapse')}
      </label>
      <label class="cv-check">
        <input type="checkbox" checked={props.value.wrap} onChange={() => set({ wrap: !props.value.wrap })} /> {t('diff.wrap')}
      </label>
    </>
  )
}

export interface DiffPanesProps {
  docA: string
  docB: string
  options: DiffOptions
  /** The text to put on the clipboard, or null to refuse. Omitted blocks copying. */
  onCopyText?: (selected: string) => string | null
  class?: string
}

export function DiffPanes(props: DiffPanesProps) {
  const host = useRef<HTMLDivElement>(null)
  const latest = useRef(props)
  latest.current = props

  useEffect(() => {
    const parent = host.current
    if (!parent) return
    parent.innerHTML = ''
    const onCopy = (e: ClipboardEvent, v: EditorView): boolean => {
      e.preventDefault()
      const handler = latest.current.onCopyText
      if (!handler) return true
      const { from, to } = v.state.selection.main
      const selected = v.state.sliceDoc(from, to)
      if (!selected) return true
      const out = handler(selected)
      if (out === null) return true
      e.clipboardData?.setData('text/plain', out)
      return true
    }
    const pane = [
      lineNumbers(),
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      markerPlugin,
      EditorView.domEventHandlers({
        copy: onCopy,
        cut: onCopy,
        contextmenu: (e) => {
          e.preventDefault()
          return true
        },
        dragstart: (e) => {
          e.preventDefault()
          return true
        },
      }),
      EditorView.theme({ '&': { fontFamily: 'var(--cv-mono)', fontSize: '13px' } }),
      ...(props.options.wrap ? [EditorView.lineWrapping] : []),
    ]
    const collapseOpt = props.options.collapse ? { margin: 3, minSize: 4 } : undefined
    if (props.options.unified) {
      const view = new EditorView({
        state: EditorState.create({
          doc: props.docB,
          extensions: [
            ...pane,
            keyGutter,
            unifiedMergeView({ original: props.docA, mergeControls: false, highlightChanges: true, gutter: true, ...(collapseOpt ? { collapseUnchanged: collapseOpt } : {}) }),
          ],
        }),
        parent,
      })
      return () => view.destroy()
    }
    const mv = new MergeView({
      a: { doc: props.docA, extensions: pane },
      b: { doc: props.docB, extensions: [...pane, keyGutter] },
      parent,
      highlightChanges: true,
      gutter: true,
      ...(collapseOpt ? { collapseUnchanged: collapseOpt } : {}),
    })
    return () => mv.destroy()
  }, [props.docA, props.docB, props.options.unified, props.options.collapse, props.options.wrap])

  return <div class={props.class ?? 'cv-diff-host'} ref={host} onContextMenu={(e) => e.preventDefault()} />
}
