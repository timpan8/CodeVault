import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { EditorState } from '@codemirror/state'
import { Decoration, EditorView, GutterMarker, MatchDecorator, ViewPlugin, gutter, lineNumbers, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { MergeView, unifiedMergeView } from '@codemirror/merge'
import { guard } from '@engine/guard'
import { render } from '@engine/template'
import type { ScriptRecord, VersionRecord } from '@vault/model'
import { getSession, toast } from '../state'
import { diffDoc, diffStats, formatStats, markersToExamples, MARKER_RE } from '../diff'
import { t } from '@i18n/index'

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

const REAL_REVERT_S = 60

export function DiffView(props: { script: ScriptRecord; versions: VersionRecord[]; aId: string; bId: string; onChangeA: (id: string) => void; onChangeB: (id: string) => void }) {
  const session = getSession()
  const host = useRef<HTMLDivElement>(null)
  const [unified, setUnified] = useState(false)
  const [collapse, setCollapse] = useState(true)
  const [wrap, setWrap] = useState(true)
  const [showReal, setShowReal] = useState(false)
  const [realLeft, setRealLeft] = useState(0)
  const fields = useMemo(() => session.fieldMap(), [])
  const a = props.versions.find((v) => v.id === props.aId)
  const b = props.versions.find((v) => v.id === props.bId)

  const docs = useMemo(() => {
    if (!a || !b) return { a: '', b: '' }
    if (showReal) {
      const real = session.snapshot().real
      return {
        a: render(a.segments, 'real', { fields, real, plain: props.script.language === 'plain' }).text,
        b: render(b.segments, 'real', { fields, real, plain: props.script.language === 'plain' }).text,
      }
    }
    return { a: diffDoc(a.segments, fields), b: diffDoc(b.segments, fields) }
  }, [a, b, showReal, fields])

  const stats = useMemo(() => (a && b ? diffStats(diffDoc(a.segments, fields), diffDoc(b.segments, fields)) : null), [a, b, fields])

  useEffect(() => {
    if (!showReal) return
    setRealLeft(REAL_REVERT_S)
    const id = setInterval(() => {
      setRealLeft((s) => {
        if (s <= 1) {
          setShowReal(false)
          return 0
        }
        return s - 1
      })
    }, 1000)
    return () => clearInterval(id)
  }, [showReal])

  useEffect(() => {
    const parent = host.current
    if (!parent) return
    parent.innerHTML = ''
    const copyHandler = (e: ClipboardEvent, v: EditorView) => {
      e.preventDefault()
      if (showReal) {
        toast(t('diff.copyBlocked'), 'error')
        return true
      }
      const { from, to } = v.state.selection.main
      const selected = v.state.sliceDoc(from, to)
      if (!selected) return true
      const text = markersToExamples(selected, fields.values())
      const snap = session.snapshot(props.script.id)
      const g = guard({ text, fields: snap.all, real: snap.real, retired: snap.retired, allowlist: snap.allowlist, ns: snap.ns, language: props.script.language })
      if (g.blocked) {
        toast(t('exit.copyForAiBlocked', { n: g.findings.length }), 'error')
        return true
      }
      e.clipboardData?.setData('text/plain', text)
      return true
    }
    const pane = [
      lineNumbers(),
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      markerPlugin,
      EditorView.domEventHandlers({
        copy: copyHandler,
        cut: copyHandler,
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
      ...(wrap ? [EditorView.lineWrapping] : []),
    ]
    const collapseOpt = collapse ? { margin: 3, minSize: 4 } : undefined
    let cleanup: () => void
    if (unified) {
      const view = new EditorView({
        state: EditorState.create({
          doc: docs.b,
          extensions: [...pane, keyGutter, unifiedMergeView({ original: docs.a, mergeControls: false, highlightChanges: true, gutter: true, ...(collapseOpt ? { collapseUnchanged: collapseOpt } : {}) })],
        }),
        parent,
      })
      cleanup = () => view.destroy()
    } else {
      const mv = new MergeView({
        a: { doc: docs.a, extensions: pane },
        b: { doc: docs.b, extensions: [...pane, keyGutter] },
        parent,
        highlightChanges: true,
        gutter: true,
        ...(collapseOpt ? { collapseUnchanged: collapseOpt } : {}),
      })
      cleanup = () => mv.destroy()
    }
    return cleanup
  }, [docs, unified, collapse, wrap])

  const label = (v: VersionRecord) => `v${v.seq}${props.script.stableVersionId === v.id ? ' ★' : ''}${v.note ? ` · ${v.note}` : ''}`

  return (
    <div class="cv-diff">
      <div class="cv-diff-controls">
        <label class="cv-label-inline">
          {t('diff.a')}
          <select class="cv-input cv-input-small" value={props.aId} onChange={(e) => props.onChangeA((e.currentTarget as HTMLSelectElement).value)}>
            {props.versions.map((v) => (
              <option key={v.id} value={v.id}>
                {label(v)}
              </option>
            ))}
          </select>
        </label>
        <label class="cv-label-inline">
          {t('diff.b')}
          <select class="cv-input cv-input-small" value={props.bId} onChange={(e) => props.onChangeB((e.currentTarget as HTMLSelectElement).value)}>
            {props.versions.map((v) => (
              <option key={v.id} value={v.id}>
                {label(v)}
              </option>
            ))}
          </select>
        </label>
        {stats && <span class="cv-chip">{t('diff.stats', { added: stats.added, removed: stats.removed })}</span>}
        <label class="cv-check">
          <input type="checkbox" checked={unified} onChange={() => setUnified(!unified)} /> {t('diff.unified')}
        </label>
        <label class="cv-check">
          <input type="checkbox" checked={collapse} onChange={() => setCollapse(!collapse)} /> {t('diff.collapse')}
        </label>
        <label class="cv-check">
          <input type="checkbox" checked={wrap} onChange={() => setWrap(!wrap)} /> {t('diff.wrap')}
        </label>
        <button type="button" class={`cv-btn cv-btn-small ${showReal ? 'cv-btn-real-armed' : ''}`} onClick={() => setShowReal(!showReal)}>
          {showReal ? '🔓' : '🔒'} {t('diff.showReal')}
        </button>
      </div>
      {showReal && <div class="cv-banner cv-banner-error">{t('diff.realBanner', { s: realLeft })}</div>}
      <div class="cv-diff-host" ref={host} onContextMenu={(e) => e.preventDefault()} />
      {stats && <p class="cv-muted cv-small">{formatStats(stats)}</p>}
    </div>
  )
}
