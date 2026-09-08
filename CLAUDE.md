# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What this is

CodeVault: a static Preact + TypeScript app for GitHub Pages that sits between an AI chat and your
editor. Code is stored as a **template** (text segments + field references) plus a separately
encrypted field table — never as code with real values in it. Two renderings of the same object:

- **För AI** — example values from reserved namespaces (`example.com`, `SRV-EXAMPLE01`, `192.0.2.x`).
- **Riktigt** — your real values, one single guarded code path (`exportReal()`).

The interface is Swedish (`src/i18n/sv.ts`, English fallback in `en.ts`). Everything is local:
IndexedDB via Dexie, encrypted with a master password. No server, no network calls.

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
9. **Only `dist/` is published.** Never user data, never a backup file.

## Architecture

```
src/engine/   pure functions, no DOM, run in a Web Worker (rpc.ts / client.ts / worker.ts)
              template.ts (template model) · reapply.ts (three-tier matching) · guard.ts (leak guard)
              detectors.ts · encoding.ts (base64/URL/JSON/HTML/backtick/regex variants) · examples.ts
src/vault/    crypto.ts · store.ts (Dexie) · lock.ts (auto-lock) · session.ts (the state machine)
              backup.ts (rotating encrypted backup + structure export) · merge.ts (cross-machine import)
src/ui/       Preact: screens/ (Setup, Unlock, Scripts, ScriptView, Sanitize, Settings, About)
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
