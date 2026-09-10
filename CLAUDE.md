# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What this is

CodeVault: a static Preact + TypeScript app for GitHub Pages that sits between an AI chat and your
editor. Code is stored as a **template** (text segments + field references) plus a separately
encrypted field table — never as code with real values in it. Two renderings of the same object:

- **För AI** — example values from reserved namespaces (`example.com`, `SRV-EXAMPLE01`, `192.0.2.x`).
- **Riktigt** — your real values, one single guarded code path (`exportReal()`).

The interface is Swedish (`src/i18n/sv.ts`, English fallback in `en.ts`). Everything is local:
IndexedDB via Dexie, every record AES-GCM under the vault DEK. No server, no network calls.

The master password is **opt-in**. A new vault has `protection: 'none'`: the DEK sits in the store's
`localKey` row beside the data, so the app opens with nothing to type. `addPassword` wraps that same
DEK under a password and a recovery key and drops the local row — header-only, so switching either
way never re-encrypts a record. An unprotected vault has no auto-lock and no lock button: locking
without a secret would only reopen itself.

## Commands

```sh
npm ci
npm run dev          # http://127.0.0.1:5173
npm test             # Vitest: engine, vault, fixtures, property tests
npm run lint         # ESLint + tsc --noEmit
npm run typecheck
npm run build        # tsc --noEmit && vite build -> dist/
npm run preview      # http://127.0.0.1:4173
npm run check-deps   # license allow-list, writes THIRD-PARTY-NOTICES.md
npm run test:e2e     # Playwright/Chromium, builds and serves the preview itself
```

A single test:

```sh
npx vitest run tests/engine/reapply.test.ts
npx vitest run -t "exact example value"
npx playwright test -g "kopierar"
```

**Check the exit code, not the output.** Lint prints warnings that are not failures; grepping its
text will tell you it passed when it did not.

## Invariants

Decisions, not accidents. Several are enforced by tests.

1. **A version is never stored as code with real values.** Template + encrypted field table only.
   Diff, version library, search and export are safe by construction.
2. **The tool owns the example values.** Stable, reserved-namespace values, preserved verbatim by the
   AI, so re-application is mostly exact string matching and a fake can never be taken for a real one.
3. **Conservative automation.** Only exact matches on the example value auto-apply. Everything else
   goes to the review view. "Kopiera riktigt" is blocked until secret fields are resolved.
4. **An independent leak guard** (`src/engine/guard.ts`) scans everything leaving through "för AI"
   against all known real values *including encoded variants*, and refuses to copy on a hit.
5. **Exactly one `exportReal()` path.** No shortcuts. `Ctrl+C`, cut and drag in the editor always give
   the sanitised rendering and run the guard.
6. **Real values never reach** the editor document, the undo history, DOM attributes, the diff model,
   the version history, error messages or issue objects.
7. **Same-origin CSP in `index.html`.** No CDN, no web fonts, no telemetry, no network calls.
8. **Inputs are `type=text`** with manual masking and `autocomplete=off`, never `type=password`.
   Masking follows sensitivity, not the widget: `masksByDefault()` in `src/engine/fields.ts` is the
   only rule, and only `sensitivity === 'secret'` is hidden by default. Identifying values — server
   names, domains, paths — are shown, because you cannot check them against the code as dots.
9. **Only `dist/` is published.** Never user data, never a backup file.
10. **Records are encrypted in both protection modes.** What changes is where the DEK lives, never
    whether it is used — there is no plaintext storage path to keep in step. A backup of an
    unprotected vault carries its `localKey`, so it opens with no secret; the UI says so before
    writing one, and `restoreIntoStore` clears a stale key when restoring a protected backup.
11. **The UI never oversells an unprotected vault.** The header carries an "Oskyddat" chip, and both
    Setup and Settings state plainly that the key sits beside the data.

## Architecture

```
src/engine/   pure functions, no DOM, run in a Web Worker (rpc.ts / client.ts / worker.ts)
              template.ts (template model) · reapply.ts (three-tier matching) · guard.ts (leak guard)
              detectors.ts · encoding.ts (base64/URL/JSON/HTML/backtick/regex variants) · examples.ts
src/vault/    crypto.ts (two protection modes, one DEK) · store.ts (Dexie) · lock.ts (auto-lock)
              session.ts (state machine: create/createUnprotected, addPassword/removePassword)
              backup.ts (rotating encrypted backup + structure export) · merge.ts (cross-machine import)
src/ui/       Preact: screens/ (Setup, Unlock, Scripts, ScriptView, Sanitize, Values, Settings, About)
              components/ (Editor, PasteSheet, DiffView, FieldsPanel, FieldForm, Exits, GuardFindings)
              state.ts (signals, routing, toasts)
src/i18n/     UI strings, sv default with en fallback
tests/        Vitest fixtures + property tests; tests/e2e Playwright
scripts/      check-deps.mjs
```

The engine runs in a worker; the UI talks to it over `rpc.ts`. Keep new pure logic in `src/engine/`
and out of components — the fixture suite is what makes re-application safe to change.

## Working style

- Swedish in the UI and in the docs; English in code and comments.
- Concise, functional solutions over layered abstraction.
- New engine behaviour gets a fixture under `tests/fixtures/` before it gets a component.
- Ask before adding a dependency: `npm run check-deps` gates licenses, and every dependency is
  supply-chain surface for a tool whose whole point is that secrets do not leave the machine.

## Porting from AI Code Vault

The older React/Monaco app in [timpan8/Coding-Tool](https://github.com/timpan8/Coding-Tool) has
features this app does not yet have. `PORTING.md` is the list, with source paths. Port the domain
logic and its tests first, the UI second — do not import React or Monaco into this app.
