/**
 * Fixed, versioned marker lines the tool adds to text it emits. Both are
 * stripped again on the next paste so versions never accumulate headers, and
 * the REAL sentinel doubles as the "this came from your editor" detector.
 */
export const SENTINEL_REAL = '# [REAL VALUES - never paste into AI] v1'
export const SENTINEL_REAL_RE = /^# \[REAL VALUES - never paste into AI\] v\d+\s*$/

export const SENTINEL_PREAMBLE =
  '# Placeholder values (example.com, SRV-EXAMPLE01, C:\\Example, ...) are intentional - keep them exactly as-is. [CodeVault v1]'
export const SENTINEL_PREAMBLE_RE = /^# Placeholder values .*\[CodeVault v\d+\]\s*$/
