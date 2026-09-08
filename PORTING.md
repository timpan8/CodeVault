# Portering från AI Code Vault

Det här repot startar från `codevault/`-appen i [timpan8/Coding-Tool](https://github.com/timpan8/Coding-Tool).
Rot-appen i det repot ("AI Code Vault", React 19 + Monaco) har funktioner som saknas här. Listan nedan
är arbetsordningen, med källsökväg i det gamla repot.

**Regel:** portera domänlogiken och dess tester först, gränssnittet sist. React, Monaco, zod, oxlint och
pnpm följer *inte* med — logiken skrivs om mot `src/engine/` och `src/vault/`, UI mot Preact och
CodeMirror. Varje portad funktion ska ha en fixture under `tests/fixtures/` innan den får en komponent.

## 1. Fler språk än PowerShell (störst värde)

Idag: `src/engine/lexer/powershell.ts` plus ett `plain`-läge. Allt annat saneras som plain text, vilket
gör escaping svagare än den behöver vara.

Gammal källa: `src/domain/render/escape.ts` (en gren per språk), `languages.test.ts`, `context.test.ts`,
`cfamily.test.ts`, `config.test.ts`. Där finns bland annat powershell, python, bash, javascript,
typescript, csharp, go, sql, json, yaml, xml, ini, dockerfile.

Att bevaka: `contextsAt()` lexar källan **en gång** för alla platshållare — den gamla per-platshållare-
varianten kostade 184 ms på en 2000-radersfil. Kontexter som inte går att escapa säkert ska vägras med
besked, aldrig gissas.

## 2. Kodade varianter i läckvakten

Idag: `src/engine/encoding.ts` täcker en del. Gammal källa: `src/domain/render/encoding.ts` +
`encoding.test.ts` — base64 (även UTF-16 och inuti längre körningar), URL-, JSON- och HTML-escaping,
backtick- och regex-escaping räknas som samma värde. Även `leak.ts` och `coverage.ts` (kopieringsdialogen
redovisar hur stor andel av kodens strängvärden som faktiskt är skyddade).

## 3. Historiska värden och exponeringsmärkning

Ett fälts tidigare riktiga värden bevakas för alltid, och ett fält vars riktiga värde dyker upp i kod som
klistras in från en AI märks som **exponerat** tills värdet byts. Gammal källa: `src/domain/bindings/`.

## 4. Regelverk för skannern

Heuristisk skanner som **varnar per träff och aldrig blockerar**, med avstängbara regler och egna sökord,
samt blocklista. Gammal källa: `src/domain/scanner/`, `src/domain/blocklist/`, UI i
`src/ui/components/RulesPanel.tsx` och `BlocklistPanel.tsx`.

## 5. Inklistringsvyn

Listar vad koden bär — användarnamn, lösenord, servrar, domäner, tenant-id, sökvägar — med rad och
sammanhang; att peka på en rad tonar värdet i editorn, det raden pekat ut är förkryssat, ett tryck skapar
fält för alla förkryssade. Gammal källa: `src/ui/components/IngestDialog.tsx`, `src/domain/detect.ts`.
Motsvarigheten här är `src/ui/components/PasteSheet.tsx` — utöka den, bygg ingen andra vy.

## 6. Fältsida och profiler

Global fältsida (`#/bindings`), namnbyte i alla mallar samtidigt, radering med värdet återskrivet i koden,
ett värde per profil (Test/Prod). Gammal källa: `src/ui/components/BindingsPage.tsx`, `BindingPanel.tsx`,
`ProfilePicker.tsx`. Står redan som v2 i README:s "väntar".

## 7. Flera filer per skript

Rot-appen har projekt med flera filer och filflikar. Gammal källa: `src/ui/components/FileTabs.tsx`,
`ProjectBrowser.tsx`, modellen i `src/types/models.ts`.

## 8. Mindre saker som är billiga att ta med

- Ångra-remsa efter radering — `src/ui/components/UndoBar.tsx`
- Introduktion vid första besöket — `src/ui/components/Intro.tsx`
- Banner så länge riktiga värden ligger kvar i urklipp, plus automatisk urklippsrensning —
  `src/ui/components/ClipboardBanner.tsx`
- Textarea i stället för kodeditor på smal skärm — `src/ui/editor/PlainEditor.tsx`
- Appversion/commit i sidfoten

## 9. Bygg- och publiceringskontroller

- `scripts/check-network.mjs` — bryter bygget på `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`,
  `sendBeacon` i bundlen, på remote `@import`/off-origin `url()` i CSS och på `preconnect`/`prefetch`/
  `preload` i HTML. Bör köras här också, som en del av `npm run build`.
- `scripts/build-sw.mjs` — service worker med precache av app-shellet, uppdatering aktiveras via notis i
  appen. Ta först när resten sitter; en offline-cache av ett valv vill man inte ha halvfärdig.

## Medvetet kvar i det gamla repot

- React 19, Monaco, zod, oxlint/prettier, pnpm.
- Rot-appens lagring i klartext. Här är valvet krypterat med master-lösenord — det är skillnaden mellan
  apparna och den ska inte portas bort.
