# Tester

Alla frontend-kommandon körs från `frontend/`, backendens från `backend/`.

## Profiler

| Profil | Kommando | Vad som körs mot vad | Bevisar |
|---|---|---|---|
| typer | `npm run lint` | `tsc --noEmit` | Att koden kompilerar. |
| enhet | `npm test` | `frontend/lib/*.test.ts` i jsdom | Logik och komponenter. |
| backend | `.venv/bin/python -m unittest discover -s tests` (från `backend/`) | backendens app i processen, med falska Eneo-svar | Inloggning, proxy, uppladdning, filer, live-relä, statisk servering, konfiguration. |
| gaten | `npm run test:a11y` | Vites utvecklingsserver, med stubben som backend | WCAG 2.2 AA och husets krav i en riktig webbläsare, per skärm. |
| gaten, granskning | `npm run test:a11y:review` | samma, startad med `SPEAKER_REVIEW_ENABLED=true` | Granskningssidan med granskningen på. |
| gaten, branding | `npm run test:a11y:branding` | samma, med stubben som en annan organisation | Att en organisation med egen accent, långt namn och bred logga klarar samma krav och att inget behåller den blå standardfärgen. |
| produktion | `npm run test:prod` | `dist/` och `dist-check/` serverade av den riktiga backenden (`python -m app.serve`), stubben som Eneo | Det byggda gränssnittet och backenden tillsammans: headers, routing, första målningen, gamla flikar, vikt. |
| imagen | `npm run test:image` | den byggda imagen bakom Traefik, stubben som Eneo | Produktionsimagen: en process, headers, uppladdningar, WebSocket, minne, stopp. |

Dessutom: `npm run astryx -- doctor` (uppsättningen), `npm run theme:build && git diff --exit-code -- kit/theme/built` (temat är aktuellt), `docker compose -f docker-compose.yml --env-file .env.example config -q` (Compose-filen, från roten). CI kör allt utom hela gaten: [Drift](operations.md#ci-och-utgåvor).

```bash
cd frontend
npm ci
npm run lint
npm test
npm run test:a11y        # stoppa din egen npm run dev först om den ligger på samma port
npm run test:prod
npm run build
cd ../backend && .venv/bin/python -m unittest discover -s tests
```

Första gången: `npx playwright install chromium` för gaten och `npx playwright install chromium webkit firefox` för `test:prod`. `test:prod` och imagens acceptans startar den riktiga backenden och behöver därför dess paket: `pip install -r backend/requirements.lock`. De startar `backend/.venv/bin/python` när den finns, annars `python3`; `BACKEND_PYTHON` pekar på en annan Python, till exempel en annan utchecknings miljö.

## Enhetstester

`npm test` kompilerar `frontend/lib/*.test.ts` med `tsc` (`tsconfig.test.json`) till `.test-build/` och kör dem med Nodes inbyggda testkörare i jsdom. Logiktester och komponenttester ligger tillsammans i `frontend/lib/`, bredvid logiken: en ny testfil måste ligga där för att köras. En fil efter bygget: `node --require ./tests/register.cjs --test .test-build/lib/<namn>.test.js`.

- jsdom saknar `showModal` och Popover API. `frontend/lib/test-dom.ts` ersätter dem med attribut och händelser, men modalitet och förankring simuleras inte: de bevisas i gaten.
- En CSS-modul i ett test blir ett objekt med klassnamnen som de är skrivna (`frontend/tests/register.cjs`).
- En ny Astryx-underväg som inte ligger under `dist/<Namn>` behöver en rad i `paths` i `frontend/tsconfig.test.json`.
- `frontend/lib/test-router.ts` ger komponenttester en data-router; IndexedDB kommer från `fake-indexeddb`.

## Gaten

`npm run test:a11y` startar stubben (`frontend/tests/e2e/stub-server.py`, bara för test: den låtsas vara modulens backend) och Vites utvecklingsserver (`frontend/playwright.config.ts`), och besöker varje läge i `frontend/tests/e2e/screens.ts` med falsk mikrofon. Inget Eneo behövs. Ett läge är ett namn och stegen dit.

**Vad som mäts** (i den renderade sidan, `frontend/tests/e2e/checks.ts`; resultat per test i `findings.json`):

| Kontroll | Regel |
|---|---|
| axe | Varje WCAG-överträdelse stoppar, oavsett allvarlighet; övriga regler när de är allvarliga eller kritiska. |
| Namn | Varje kontroll har ett namn i Chromiums tillgänglighetsträd. |
| Platshållartext | Kontrast 4,5:1. |
| Målstorlek | 24 px med mus, 44 px med finger (`pointer: coarse`). |
| Reflow och textavstånd | Inget utanför kanten eller avklippt vid 320 px, 200 % zoom och ökat radavstånd, teckenavstånd och ordavstånd; en rubrik kapas inte. |
| Rörelse | Inga oändliga animationer med reducerad rörelse. |
| Tangentbord | Fokus syns (minst 3:1 förändring), skyms inte, lämnar sidan i slutet och ordningen läses uppifrån och ned. |
| ARIA-ögonblicksbilder | Namn, roller, tillstånd och texten i live-regionerna, jämförd med granskade bilder i `frontend/tests/e2e/aria.spec.ts-snapshots/`. |

**Specarna** i `frontend/tests/e2e/`: `a11y.spec.ts` (mätningarna, för varje läge och projekt), `keyboard.spec.ts` (tangentbordsvandringar), `aria.spec.ts`, `names.spec.ts`, `harness.spec.ts` (gatens egna kontroller mot sidor byggda för att fela), `color-mode.spec.ts`, `session-cover.spec.ts` (inget av sidan eller av en dialog den hade öppen syns eller nås medan inloggningen är slut), `route-change.spec.ts` och `leave-guard.spec.ts` (titel, fokus och scroll efter en navigering; att lämna en sida med en inspelning), `flow-list.spec.ts`, `result-tabs.spec.ts`, `header-fit.spec.ts`, `live-sheet.spec.ts`, `recording-short.spec.ts`, `review-editor.spec.ts`, `leaks.spec.ts` (se nedan), `branding.spec.ts` och `review-flag.spec.ts` (bara i sina profiler). Specerna väljer själva vilka projekt de gäller.

**Projekten** (19, i `playwright.config.ts`): telefoner (320 och 390 px, ljust och mörkt), surfplattor (768 och 1024 px), laptop (1280 och 1440 px), `zoom-200`, `forced-colors`, `ultrawide` (1920, 2560 och 3440 px) och `reduced-motion`. `a11y.spec.ts` körs i alla; tangentbord, ARIA och namn där de skiljer sig (`testIgnore` i konfigurationen).

```bash
# Ett läge, smalast och mörkt, medan du bygger det
npm run test:a11y -- a11y.spec.ts -g "<läge>" --project=phone-320-light --project=laptop-1440-dark
# Efter en avsiktlig ändring av vad skärmläsaren får, för det läget
npm run test:a11y -- aria.spec.ts --update-snapshots -g "<läge>"
```

Läs diffen på ögonblicksbilderna innan du behåller dem.

**Vad gaten inte bevisar:** vad en skärmläsare faktiskt läser upp (axe:s _incomplete_ listas som `manual check` i rapporten), PDF-visarens egna fokus (grinden kräver att visaren inte stänger in fokus och att Escape stänger dialogen från dess egna kontroller), och webbläsare utan förankrade menyer (Safari 17 till 25, Firefox före 147), som kontrolleras för hand en gång per release.

**Regler som aldrig ändras:** sänk inte ett tröskelvärde, ta inte bort ett läge ur gaten och lägg inte till ett axe-undantag för att få den grön. Hitta orsaken; en brist i designsystemet rättas en gång i temat ([Frontend](frontend.md#rätta-en-brist-i-designsystemet)).

### Läckkontrollen

`frontend/tests/e2e/leaks.spec.ts` öppnar och stänger varje överlägg 40 gånger och jämför Chromiums egna räknare (DOM-noder, lyssnare, minne) efter skräpsamling, före och efter. Ett läckage växer med varje varv. Fem uppvärmningsvarv räknas inte; marginalen för de 40 öppningarna är 20 noder, 20 lyssnare och 1,5 MB, och den höjs aldrig för att få ett test att passera. Chromium behåller elementet som senast låg under pekaren tills pekaren flyttas, så specen flyttar pekaren bort efter varje stängning. Ett av överläggen läcker med avsikt (`/dev/dialog-leak`, bara på utvecklingsservern), så att specen visar att den kan fela. Ett nytt överlägg läggs till i `OVERLAYS` i samma ändring som inför det.

## Produktionstesterna

`npm run test:prod` bygger `dist/` och `dist-check/` och startar den riktiga backenden (`node tests/prod/start-backend.mjs`, alltså `python -m app.serve`) framför stubben som Eneo, med verklig inloggning genom stubbens `/module-login`. Tre backends, eftersom ett bygge innehåller det dess tester väntar sig: `shipped` på `dist/` (allt som inte är märkt `@fixture` eller `@branded`, i Chromium, WebKit och Firefox), `fixture` på `dist-check/` (utvecklingssidorna) och `branded` på `dist/` som en grön organisation. Ett test säger själv vilken det är i sin titel.

| Test (`frontend/tests/prod/`) | Bevisar |
|---|---|
| `headers.spec.ts` | Att varje svar bär säkerhetsheadrarna i `backend/app/security_headers.json`, och att bara den inline PDF:en får ramas in, av den egna origin. |
| `routes.spec.ts` | Att varje adress i appen är sidan, att en saknad fil eller en okänd `/api`-sökväg är ett 404 som inte är en sida, och att en vanlig build inte har utvecklingssidor. |
| `first-paint.spec.ts` | Att de första bildrutorna har rätt färgläge och organisationens märke, med långsamt eller blockerat JavaScript. |
| `stale-chunk.spec.ts`, `stale-chunk-recording.spec.ts` | Att en flik som stått öppen över en ny version lämnas med en rad och en omladdningsknapp, och att en pågående inspelning inte går förlorad. |
| `upstream.spec.ts` | Vad modulen gör med en förfrågan på vägen till Eneo och tillbaka, läst ur stubben. |
| `smoke.spec.ts`, `branding.spec.ts` | Att designsystemet är stylat och tematiserat i det byggda bygget utan blockerat eller trasigt innehåll, och att en organisations accent gäller också under strikt `style-src 'self'`. |
| `weight.spec.ts` | Att en sidas komprimerade JS och CSS inte överstiger `weight-budget.json`, och att det byggda temat används (inget `<style data-astryx-theme*>` efter laddning). Bara Chromium, som rapporterar överföringsstorlek. |

Budgetarna och skälen: [beslut 0007](decisions/0007-weight-budget.md).

## Imagens acceptans

`npm run test:image` (`deploy/acceptance.sh`) startar `docker-compose.yml`, den riktiga tjänsten, med stubben som Eneo och en Traefik framför (`deploy/acceptance/compose.yml`) och kör 16 kontroller (`python3 deploy/acceptance/checks.py --list` säger vad var och en bevisar; `--only 4,5,9` kör några): hälsa, en process och icke-root, att varje route är sidan och inget omdirigerar, 404 utan HTML, headrarna, `test:prod` mot imagen, Range, WebSocket-ramar, uppladdningars minne och tak, stopp med en fil som strömmar, inline-PDF, att granskningsflaggan och utvecklingssidorna bara finns i sina bygg, imagens storlek och minne mot `deploy/acceptance/baseline.json`, live-reläets fördröjning under last och hela vägen genom Traefik. Behöver Docker, `npm ci` i `frontend/` och Playwright. Portarna (127.0.0.1) är `ACCEPT_TRAEFIK_PORT` 8480, `ACCEPT_ENEO_PORT` 8481 och `ACCEPT_DIRECT_PORT` 8482.

Ett fel som ägaren godtagit står i `deploy/acceptance/waivers.json`, med beslut, skäl och siffror; det skrivs ändå ut som `FAIL (waived: ...)`.

## Portar och flera utcheckningar

| Kontroll | Standardportar (app, stub) | Ändra med |
|---|---|---|
| gaten, `npm run dev:stub` | 3401, 8401 | `A11Y_APP_PORT`, `A11Y_STUB_PORT` |
| `npm run test:prod` | 3411 till 3413, 8411 | samma två variabler |
| `npm run test:image` | 8480 till 8482 | `ACCEPT_*_PORT` |

Flera utcheckningar (git worktrees) kan köra testerna samtidigt på egna portpar, till exempel `A11Y_APP_PORT=3464 A11Y_STUB_PORT=8464 npm run test:a11y -- ...`. Gaten kör fyra arbetare mot den enda utvecklingsservern; fler svälter den. Döda aldrig en process du inte startat och använd aldrig `pkill -f`: stoppa det du startat via dess PID eller port.

## Läsa ett fel

| Det du ser | Betyder | Gör så här |
|---|---|---|
| `targets under 44 px on a coarse pointer (house bar)` | Ett pekmål är för litet | Rätta storleken i temat, inte på ett enskilt ställe. |
| `axe: WCAG violations …` med regel-id och selektor | En axe-överträdelse | `findings.json` för testet har alla noder och förklaringen. |
| `content past the edge or cut off` | Reflow- eller textavståndsfel | Kör samma läge i `phone-320-light` och `zoom-200`; kontrollera långa svenska ord. |
| `<sida> loads X KB of JS, the budget is Y KB` | Sidan blev tyngre än budgeten | Hitta importen som växte; höj budgeten bara med skäl. |
| `a <style data-astryx-theme*> means the theme is built in the browser` | Temat byggs i webbläsaren | Importera det byggda temat, `kit/theme/built/eneo`. |
| Konsolfel i ett produktionstest | Oftast en CSP-vägran | Felet anger vilket direktiv som stoppade vad. |

Resultaten finns i `frontend/test-results/a11y/*/findings.json` och i HTML-rapporten (`npx playwright show-report test-results/a11y-report`), där `manual check` listas. Ett spår behålls för misslyckade tester (`npx playwright show-trace <mapp>/trace.zip`). Skärmbilder: `SHOTS=1 npm run test:a11y -- a11y.spec.ts -g "<läge>" --project=phone-390-light` skriver `test-results/shots/<projekt>/<läge>.png`. Se ett enskilt läge i en webbläsare med fönster: `npm run state -- "<läge>"`.

## Lägga till en skärm eller ett överlägg

1. Lägg lägen för skärmen i `frontend/tests/e2e/screens.ts`; `a11y.spec.ts` besöker dem i alla projekt.
2. Behöver den en tangentbordsvandring eller en ARIA-ögonblicksbild, lägg den i `keyboard.spec.ts` respektive `aria.spec.ts`.
3. Är det ett överlägg, lägg det i `OVERLAYS` i `leaks.spec.ts`.
4. Kör läget i `phone-320-light` och `zoom-200` före hela gaten.
