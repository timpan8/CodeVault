# CodeVault

Ett webbverktyg som sitter mellan AI-chatten och ditt kodverktyg. Det är en ren klientapp: allt du lagrar krypteras i din webbläsare och ingen server ser dina värden. Du klistrar in kod från AI:n, markerar var dina riktiga värden (användarnamn, lösenord, servrar, tenant-id, sökvägar) ska sitta, och verktyget minns dem. Nästa version från AI:n klistras in, fälten återappliceras, och du kopierar ut riktig kod till editorn eller sanerad kod tillbaka till AI:n. Inget riktigt värde lämnar någonsin verktyget via "Kopiera för AI".

## Ursprung

Kodbasen kommer från mappen `codevault/` i [timpan8/Coding-Tool](https://github.com/timpan8/Coding-Tool) och är här flyttad till repo-roten med egen historik. Den äldre app som låg i rotens `src/` ("AI Code Vault", React + Monaco) följer **inte** med — dess funktioner portas in hit efter hand, se [PORTING.md](PORTING.md).

## Grundidén

- **En version lagras aldrig som kod med riktiga värden.** Den lagras som en mall (textsegment + fältreferenser) och en separat krypterad fälttabell. "Kod för AI" och "riktig kod" är två renderingar av samma objekt. Diff, versionsbibliotek, sök och export blir säkra genom konstruktion.
- **Verktyget äger exempelvärdena.** Stabila, realistiska till formen men i reserverade namnrymder (`example.com`, `corp.example`, `SRV-EXAMPLE01`, `192.0.2.x`, `C:\Example\Project01`). AI:n bevarar dem ordagrant, så återapplicering blir i huvudsak exakt strängmatchning, och en fejk kan aldrig förväxlas med ett riktigt värde.
- **Konservativ automatik.** Bara exakta träffar på exempelvärdet autoappliceras. Allt annat visas i en granskningsvy. "Kopiera riktigt" blockeras tills hemliga fält är lösta.
- **Lösenordet är ett tillval, inte en tröskel.** Valvet startar utan master-lösenord så att du kan använda verktyget direkt. Posterna krypteras alltid, men utan lösenord ligger nyckeln bredvid datan i webbläsaren, så skyddet är då webbläsarprofilen och inget mer. Du kan lägga till ett lösenord när som helst under **Inställningar → Säkerhet**; bara headern skrivs om, så det går på ett ögonblick oavsett hur mycket du har sparat, och lika enkelt att ta bort igen.
- **En oberoende läckvakt** skannar allt som lämnar "för AI" mot alla kända riktiga värden (inklusive kodade varianter) och vägrar kopiera vid träff.

## Ordlista

| Ord | Betydelse |
| --- | --- |
| Valv | Hela datamängden, krypterad med ditt master-lösenord |
| Skript | En kodfil med ett versionsbibliotek |
| Version | En oföränderlig ögonblicksbild per inklistring |
| Fält | Ett känsligt värde med två renderingar: **exempelvärde** (till AI:n) och **riktigt värde** (till editorn) |
| Markera | Peka ut var i koden ett fält sitter |
| Kopiera för AI | Sanerad rendering, alltid genom läckvakten |
| Kopiera riktigt | Riktig rendering, en enda skyddad kodväg |
| Skyddat valv | Valv med master-lösenord: nyckeln finns ingenstans på disk |
| Oskyddat valv | Valv utan lösenord: nyckeln ligger bredvid datan, öppnas direkt |

## Hotmodell i korthet

Det verktyget alltid skyddar mot, oavsett läge: att riktiga värden når AI-chatten via urklipp (läckvakten står mellan), att de ligger i klartext på disk (varje post är AES-GCM i IndexedDB) och skärmdelning (maskerat som standard).

Vad master-lösenordet lägger till: utan lösenord ligger valvets nyckel i samma databas som datan, så vem som helst som kommer åt din inloggade webbläsarprofil kan öppna valvet — och auto-lås är då avstängt, eftersom ett lås utan hemlighet bara skulle låsa upp sig självt igen. Med lösenord finns nyckeln ingenstans på disk och auto-låset gör nytta. Backupfilen ärver samma sak: en backup av ett oskyddat valv bär med sig sin egen nyckel (annars gick den inte att öppna på en annan maskin) och är därför bara så säker som platsen du lägger den på.

Det skyddar **inte**, i något läge, mot webbläsartillägg som läser sidan, mot en editor med inbyggd AI (Copilot, Cursor) som redan ser den riktiga filen, och det kan inte radera poster ur Windows urklippshistorik (Win+V) från en webbsida.

## Köra

Utveckling:

```
npm install
npm run dev        # http://127.0.0.1:5173
```

Produktion: `npm run build` ger en statisk `dist/`-mapp som kan serveras från vilken statisk host som helst (GitHub Pages, en mapp bakom en enkel webbserver, eller `npm run preview` lokalt). Appen behöver ingen backend. Servera alltid över http(s), inte via `file://`, annars fungerar urklipp, kryptering och lagring inkonsekvent.

```
npm run build
npm run preview     # http://127.0.0.1:4173
npm run check-deps  # alla licenser tillåtna, THIRD-PARTY-NOTICES.md skrivs
```

GitHub Pages: `.github/workflows/pages.yml` bygger `dist/` och publicerar den vid varje push till `main`. Aktivera en gång under **Settings → Pages → Source: GitHub Actions**. `base` i `vite.config.ts` är `'./'`, så bygget fungerar under repo-sökvägen (`https://timpan8.github.io/CodeVault/`) utan extra konfiguration. Publicera aldrig backupfiler eller användardata i repot.

Tester och lint:

```
npm test            # Vitest: motor, valv, fixtures, egenskapstester
npm run lint        # ESLint + tsc
npm run test:e2e    # Playwright i Chromium: hela kärnloopen i en riktig webbläsare
```

Sidan **Om** i appen kör motorns fixture-svit i webbläsaren (självtest) och visar THIRD-PARTY-NOTICES.

## Arbetsflöde

1. Första start: **Kom igång direkt**, eller sätt ett master-lösenord med en gång. Väljer du lösenord får du en återställningsnyckel att spara.
2. **Importera från min editor** eller **Ny version från AI**: klistra in, granska kandidaterna (auto, bekräfta, nya, saknas, okända), spara.
3. **Kopiera för AI** ger den sanerade renderingen, alltid genom läckvakten. **Kopiera riktigt** kräver två tryck och visar en checklista först.
4. Nästa version från AI:n: klistra in, fälten återappliceras, granska det som inte var exakt.
5. **Diff** jämför två versioner på mallnivå: fält är atomära markörer, ändrade exempelvärden ger ingen hunk.
6. **Sanera text** för felmeddelanden och transcript som inte ska sparas som version.

Kortkommandon:

| Tangent | Gör |
| --- | --- |
| `Ctrl+Shift+N` | Ny version från AI |
| `Ctrl+Shift+M` | Markera markerad text som fält |
| `Ctrl+Shift+C` | Kopiera för AI |
| `Ctrl+Shift+D` | Diff |
| `Alt+Upp` / `Alt+Ner` | Byt version |
| `Ctrl+Shift+L` | Lås valvet (bara när det har ett master-lösenord) |

"Kopiera riktigt" har med avsikt inget kortkommando.

## Vad som ingår och vad som väntar

Ingår: mall + fält, konservativ återapplicering med granskningsvy, läckvakt i tre pass, krypterat valv som startar utan lösenord och kan skyddas med ett i efterhand (med återställningsnyckel och auto-lås), roterande krypterad backup och struktur-export, import av backup från en annan maskin med merge, sanera-text-ruta, tabellblock som fält, diff, härledda sökvägsfält från en Root, New-Item-rad.

Väntar (v2): testdatatabeller med generatorer, miljöprofiler (Test/Prod), sökvägssänk-panel med klicka-för-att-tillämpa, standardsnippets, patch-läge för partiella AI-svar, semantisk sammanfattning av vad som ändrats mellan versioner.

## Struktur

```
src/engine/   rena funktioner utan DOM (lexer, mall, återapplicering, läckvakt), körs i en Web Worker
src/vault/    kryptering, lagring, lås, backup, merge
src/ui/       Preact-gränssnitt
src/i18n/     UI-strängar (sv default, en fallback)
tests/        Vitest: fixtures och egenskapstester; tests/e2e: Playwright
scripts/      check-deps.mjs (licenser och THIRD-PARTY-NOTICES)
```

## Säkerhetsregler i koden

- Riktiga värden finns aldrig i editor-dokumentet, ångrahistoriken, DOM-attribut, diff-modellen eller versionshistoriken.
- Exakt en `exportReal()`-kodväg. Inga genvägar.
- `Ctrl+C`, klipp och drag i editorn ger alltid den sanerade renderingen och kör vakten.
- `index.html` bär en same-origin-CSP. Inga CDN-länkar, inga webbfonter, ingen telemetri. Appen gör inga nätverksanrop av sig själv.
- Alla inmatningsfält är `type=text` med manuell maskering och `autocomplete=off`, aldrig `type=password`.
