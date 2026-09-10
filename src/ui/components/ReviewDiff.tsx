import { useState } from 'preact/hooks'
import { DiffOptionControls, DiffPanes, defaultDiffOptions, type DiffOptions } from './DiffPanes'
import { t } from '@i18n/index'

/**
 * What the version being reviewed changes against the one before it. Both
 * documents come from diffDoc(), where every field is one ⟦MARKER⟧, so no real
 * value can be in either.
 *
 * No copy handler and no "show real": this is the step where unresolved secret
 * slots live, and it is exactly where invariant 3's gate should be strictest.
 * Copying ⟦MARKER⟧ text would be useless anyway.
 */
export function ReviewDiff(props: { prevDoc: string; nextDoc: string; prevSeq: number }) {
  const [options, setOptions] = useState<DiffOptions>(defaultDiffOptions)
  return (
    <div class="cv-review-diff">
      <div class="cv-diff-controls">
        <span class="cv-muted cv-small">{t('paste.diffHint', { seq: props.prevSeq })}</span>
        <DiffOptionControls value={options} onChange={setOptions} />
      </div>
      <DiffPanes docA={props.prevDoc} docB={props.nextDoc} options={options} />
    </div>
  )
}
