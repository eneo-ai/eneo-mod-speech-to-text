# Tester

Alla frontend-kommandon körs från `frontend/`, backendens från `backend/`.

## Profiler

| Profil | Kommando | Vad som körs mot vad | Bevisar |
|---|---|---|---|
| typer | `npm run lint` | `tsc --noEmit` | Att koden kompilerar. |
| enhet | `npm test` | `frontend/lib/*.test.ts` i jsdom | Logik och komponenter. |
| backend | `.venv/bin/python -m unittest discover -s tests` (från `backend/`) | backendens app i processen, med falska Eneo-svar | Inloggning, proxy, uppladdning, filer, live-relä, statisk servering, konfiguration. |
| gaten | `npm run test:a11y` | Vites utvecklingsserver, med stubben som backend | WCAG 2.2 AA och husets krav i en riktig webbläsare, per skärm. |
| gaten, riktigt mål | `npm run test:a11y:real` | samma lägen och specar på `dist-check/`, serverad av den riktiga backenden under den strikta policyn, stubben som Eneo | Det som levereras, med en vaktpost som stoppar policybrott, omdirigeringar och oväntade fel. |
| gaten, granskning | `npm run test:a11y:review` | samma som gaten, startad med `SPEAKER_REVIEW_ENABLED=true` | Granskningssidan med granskningen på. |
| gaten, branding | `npm run test:a11y:branding` | samma som gaten, med stubben som en annan organisation | Att en organisation med egen accent, långt namn och bred logga klarar samma krav och att inget behåller den blå standardfärgen. |
| produktion | `npm run test:prod` | `dist/` och `dist-check/` serverade av den riktiga backenden, stubben som Eneo | Det byggda gränssnittet och backenden tillsammans: headers, routing, första målningen, gamla flikar, vikt. |
| imagen | `npm run test:image` | den byggda imagen bakom Traefik, stubben som Eneo | Produktionsimagen: en process, headers, uppladdningar, WebSocket, minne, stopp. |
| sajten | `npm run build` och `npm run check` i `docs-site/` | den byggda dokumentationssajten i en riktig webbläsare | Att inga länkar är döda, att startsidan och API-sidan klarar axe, tangentbord och 390 px utan konsolfel eller externa anrop, och att varje diagram ritas. |

Dessutom: `npm run astryx -- doctor` (uppsättningen), `npm run theme:build && git diff --exit-code -- kit/theme/built` (temat är aktuellt) och `docker compose -f docker-compose.yml --env-file .env.example config -q` (Compose-filen, från roten). CI kör allt utom hela gaten ([Drift](operations.md#ci-och-utgåvor)).

Före en pull request, billigast först:

```bash
cd frontend
npm ci
npm run lint
npm test
npm run test:a11y          # egna portar, så din egen npm run dev (3002) kan ligga kvar
npm run test:a11y:real     # bygger dist-check/ och kör gaten mot den riktiga backenden
npm run test:prod
npm run build
cd ../backend && .venv/bin/python -m unittest discover -s tests
```

Första gången: `npx playwright install chromium` för gaten och `npx playwright install chromium webkit firefox` för `test:prod`. Det riktiga målet, `test:prod` och imagens acceptans startar den riktiga backenden och behöver därför dess paket: `pip install -r backend/requirements.lock`. De startar `backend/.venv/bin/python` när den finns, annars `python3`; `BACKEND_PYTHON` pekar på en annan Python, till exempel en annan utchecknings miljö.

## Enhetstester

`npm test` kompilerar `frontend/lib/*.test.ts` med `tsc` (`tsconfig.test.json`) till `.test-build/` och kör dem med Nodes inbyggda testkörare i jsdom. Logiktester och komponenttester ligger tillsammans i `frontend/lib/`, bredvid logiken: en ny testfil måste ligga där för att köras. En fil efter bygget: `node --require ./tests/register.cjs --test .test-build/lib/<namn>.test.js`.

- jsdom saknar `showModal` och Popover API. `frontend/lib/test-dom.ts` ersätter dem med attribut och händelser, men modalitet och förankring simuleras inte: de bevisas i gaten.
- En CSS-modul i ett test blir ett objekt med klassnamnen som de är skrivna (`frontend/tests/register.cjs`).
- `frontend/lib/css-tokens.test.ts` kräver att CSS-modulerna och `styles/globals.css` tar avstånd, radie, färg, teckenstorlek och kantbredd från tokens (`var(--spacing-*)`, `--radius-*`, `--color-*`, `--font-size-*`, `--border-width`). Ett rått px-, rem- eller em-värde eller en rå färg i de egenskaperna fäller testet, om det inte står i `ALLOWED` med sitt skäl eller i `TO_REPLACE` med den token som ska ta dess plats. En post som inte längre förekommer fäller också testet, så listorna bara krymper.
- `frontend/lib/test-router.ts` ger komponenttester en data-router; IndexedDB kommer från `fake-indexeddb`.

## Gaten

`npm run test:a11y` startar stubben (`frontend/tests/e2e/stub-server.py`, bara för test: den låtsas vara modulens backend) och Vites utvecklingsserver (`frontend/playwright.config.ts`, som också listar projekten: telefoner, surfplattor, laptop, 200 % zoom, forcerade färger, bred skärm och reducerad rörelse), och besöker varje läge i `frontend/tests/e2e/screens.ts` med falsk mikrofon. Inget Eneo behövs. Ett läge är ett namn och stegen dit; specarna i `frontend/tests/e2e/` är döpta efter vad de bevisar.

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

```bash
# Ett läge, smalast och mörkt, medan du bygger det
npm run test:a11y -- a11y.spec.ts -g "<läge>" --project=phone-320-light --project=laptop-1440-dark
# Efter en avsiktlig ändring av vad skärmläsaren får, för det läget
npm run test:a11y -- aria.spec.ts --update-snapshots -g "<läge>"
```

Läs diffen på ögonblicksbilderna innan du behåller dem.

**Vad gaten inte bevisar:** vad en skärmläsare faktiskt läser upp (axe:s _incomplete_ listas som `manual check` i rapporten), PDF-visarens egna fokus, och webbläsare utan förankrade menyer (Safari 17 till 25, Firefox före 147), som kontrolleras för hand en gång per release.

**Regler som aldrig ändras:** sänk inte ett tröskelvärde, ta inte bort ett läge ur gaten och lägg inte till ett axe-undantag för att få den grön. Hitta orsaken; en brist i designsystemet rättas en gång i temat ([Frontend](frontend.md#rätta-en-brist-i-designsystemet)).

`frontend/tests/e2e/leaks.spec.ts` öppnar och stänger varje överlägg 40 gånger och jämför Chromiums räknare för DOM-noder, lyssnare och minne ([beslut 0007](decisions/0007-weight-budget.md)); ett nytt överlägg läggs i `OVERLAYS` där i samma ändring som inför det.

`frontend/tests/e2e/controls.spec.ts` trycker på varje synlig, aktiverad knapp, länk, menyval, flik, brytare, kryssruta och radioknapp i varje läge, var och en i en ny kopia av läget (en egen webbläsarkontext). Den kräver ett synligt svar (adressen, fokus, en överlagring, ett aria-tillstånd, en live-region eller innehållet ändras), inga konsol- eller nätverksfel som läget inte deklarerat och att det som öppnades går att stänga med Escape eller sin egen stängknapp. Det som inte trycks (`SKIPPED`), det som med avsikt inte svarar (`NO_RESPONSE`) och det som får ge ett fel (`EXPECTS`) står med skäl i filen; ett val som redan är gjort, eller en länk till sidan man är på, trycks inte. Den körs bara på dev-profilen, i `laptop-1440-light` och `phone-390-light`, och tar ungefär 20 minuter.

### Gaten på det riktiga målet

`npm run test:a11y:real` (`GATE_TARGET=real`) kör samma lägen och specar mot det byggda gränssnittet (`dist-check/`, från `npm run build:check`) serverat av `python -m app.serve` under den strikta policyn i `backend/app/security_headers.json`, med stubben som Eneo. Varje test får en egen session genom den riktiga inloggningen, och en vaktpost (`frontend/tests/e2e/sentinel.ts`) bevakar det:

- Ett brott mot policyn (Content-Security-Policy) fäller testet, alltid. Ett läge kan inte deklarera det: policyn lättas aldrig för att ett test ska gå igenom.
- En omdirigering fäller testet, utom inloggningens egna (`/api/auth/login`, `/api/auth/callback` och stubbens `/module-login`).
- Ett konsolfel, ett ofångat fel eller ett misslyckat anrop fäller testet om läget inte deklarerat det med `expects` i `screens.ts`, och ett deklarerat fel som inte inträffar fäller det också: ett läge som ska orsaka ett fel bevisar att det gör det. Ett anrop som webbläsaren eller sidan själv avbrutit (`net::ERR_ABORTED`) räknas inte.
- `sentinel.spec.ts` orsakar vart och ett av dem och ser att vaktposten ser det.

`REAL_EXTERNAL_URL` kör gaten mot en backend som redan är igång (imagen bakom Traefik, som imagens acceptans gör) i stället för att starta en; stubben är då den driftsättningens Eneo, på en adress webbläsaren når.

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

`npm run test:image` (`deploy/acceptance.sh`) startar `docker-compose.yml`, den riktiga tjänsten, med stubben som Eneo och en Traefik framför (`deploy/acceptance/compose.yml`) och kör kontroller av imagen: hälsa, en process och icke-root, headrarna, uppladdningar, WebSocket, stopp med en fil som strömmar, imagens storlek och minne, och live-reläets fördröjning under last. `python3 deploy/acceptance/checks.py --list` säger vad var och en bevisar; `--only 4,5,9` kör några. Behöver Docker, `npm ci` i `frontend/` och Playwright. Portarna (127.0.0.1) är `ACCEPT_TRAEFIK_PORT` 8480, `ACCEPT_ENEO_PORT` 8481 och `ACCEPT_DIRECT_PORT` 8482. Ett fel som ägaren godtagit står i `deploy/acceptance/waivers.json` och skrivs ändå ut som `FAIL (waived: ...)`.

## Portar och flera utcheckningar

| Kontroll | Standardportar (app, stub) | Ändra med |
|---|---|---|
| gaten, `npm run test:a11y:real`, `npm run dev:stub` | 3401, 8401 | `A11Y_APP_PORT`, `A11Y_STUB_PORT` |
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

En ny skärm eller ett nytt överlägg: [Frontend](frontend.md#lägga-till-en-skärm).
