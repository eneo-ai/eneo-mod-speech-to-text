# Tester

Alla frontend-kommandon körs från `frontend/`, backendens från `backend/`. **Gaten** är webbläsartestet som besöker varje skärm och mäter tillgänglighet (WCAG 2.2 AA) och husets krav; "gaten" betyder det på den här sidan och i resten av dokumentationen.

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
| sajten | `npm test`, `npm run build`, `npm run typecheck` och `npm run check` i `docs-site/` | den byggda dokumentationssajten i en riktig webbläsare | Alla dokumentations- och API-sidor vid 390 och 1440 px, ljust och mörkt: axe, lokala länkar och resurser, svensk sökning, tangentbord, menyer, tabeller och diagram. |

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
| Reflow och textavstånd | Ingen text eller kontroll utanför fönstrets kant och inget avklippt av en ruta som klipper, i varje läge på varje bredd gaten har (också 1000 px, strax under laptopens två kolumner); ökat radavstånd, teckenavstånd och ordavstånd klipper inget, och en rubrik kapas inte. |
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

`frontend/tests/e2e/result-playback.spec.ts` kontrollerar ordklick, ljudposition, markeringen när ljudet pausas, skillnaden mellan sökträff och aktuellt ord, kontrasten i båda färglägena, tangentbordslänken förbi transkriberingen och avståndet till rättningens knappar. `field-focus.spec.ts` kräver en enda fokusram för sökfält och rättningsfält.

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

Kontroll 15 skiljer mättnad från ankomsttakt. Mättnadens 200 klienter återanvänder var sin HTTP-anslutning och hämtar varje svar utan cache; då begränsas inte testet av lastgeneratorns tillfälliga TCP-portar. Vid bestämd ankomsttakt öppnar varje besök fortfarande en ny anslutning. Rapporten anger metoden och skiljer HTTP-statusfel från anslutnings- och svarsfel. Alla räknas som fel; en mätning med en annan anslutningsmetod är ingen direkt före/efter-jämförelse av kapacitet.

## Portar och flera utcheckningar

| Kontroll | Standardportar (app, stub) | Ändra med |
|---|---|---|
| gaten, `npm run test:a11y:real`, `npm run dev:stub` | 3401, 8401 | `A11Y_APP_PORT`, `A11Y_STUB_PORT` |
| `npm run test:prod` | 3411 till 3413, 8411 | samma två variabler |
| `npm run test:image` | 8480 till 8482 | `ACCEPT_*_PORT` |

Flera utcheckningar (git worktrees) kan köra testerna samtidigt på egna portpar, till exempel `A11Y_APP_PORT=3464 A11Y_STUB_PORT=8464 npm run test:a11y -- ...`. Gaten kör fyra arbetare mot den enda utvecklingsservern; fler svälter den. Döda aldrig en process du inte startat och använd aldrig `pkill -f`: stoppa det du startat via dess PID eller port.

### Arbeta med en rättning

Gör den avgränsade granskningen av kod, beteende och bilder först. Reproducera fyndet i dess läge och profil, med ett riktat test och en skärmbild. Rätta i den komponent eller det tema som äger beteendet, kör de berörda testerna och granska bilddiffen. Kör sedan hela matrisen på en stabil kandidat: ändra inte dess källkod, testfiler eller byggda filer medan den körs. En separat kopia skyddar kandidaten när annat arbete pågår. Egna portar skyddar bara servrarna; de skyddar inte filer som ett annat bygge skriver över. Om ett nytt verifierat fel kräver en annan kandidat redovisas en stoppad körning som avbruten.

Kör dokumentation och faktauppslag parallellt med verifieringen. Samordna byggsteg och begränsa antalet webbläsararbetare när flera körningar delar dator, så att ett överbelastat testsystem inte döljer resultatet. Efter en ändring av kandidaten körs kontrollerna som påverkas; en tidigare grön körning gäller den kod den faktiskt testade.

`npm run verify:candidate` gör en separat kopia av aktuella källfiler, nya testfiler och installerade frontend-beroenden i en egen tillfällig katalog. Ocommittade ändringar följer med; ignorerade arbetsfiler följer inte med. Källfilerna skrivskyddas, de två byggena görs en gång och även deras filer skrivskyddas. Kontrollerna körs sedan i turordning med två arbetare och utan att återanvända befintliga servrar. Efter lint, enhets- och backendtester samt byggen körs produktionskontrakten, det byggda riktiga målet, granskning, branding, den längre dev-matrisen och bilderna. Ett snabbt fel i det som ska levereras stoppar alltså innan den dyrare dev-körningen börjar; en godkänd release kör fortfarande alla profiler. Kontrollsummor före och efter varje steg gör att ändrade, saknade eller tillagda indata och byggfiler underkänner kandidaten.

```bash
# Hela matrisen: typer, enheter, backend, dev, riktigt mål, produktion,
# granskning, båda branding-profilerna och alla bilder i 23 storlekar.
npm run verify:candidate
# Bara berörda kontroller, fortfarande på en separat kandidat.
npm run verify:candidate -- --checks lint,unit,prod --app-port 4061 --stub-port 9061
# En detalj i dev och byggd app, i samtliga skärmprofiler.
npm run verify:candidate -- --checks dev,real --grep "one focus frame"
```

Skriptet skriver kandidatens sökväg, källornas SHA-256 och varje stegs logg. `candidate.json` sparar urvalet, kontrollsummorna och resultaten; webbläsarrapporter och bilder ligger under kandidatens `frontend/test-results/` respektive `frontend/ux-shots/`. Kandidaten behålls även vid fel. `--status <kandidatens sökväg>` läser en kort sammanställning med stegstatus och färdiga webbläsarrapporters testantal. Den verifierar inga kontrollsummor; `--verify <kandidatens sökväg>` gör det. Ett resultat gäller kandidatens fångade filer och registrerade körmiljö. Skriptet sparar Node-version och binär, Python-version och installerade paketfiler samt Playwright-version och webbläsarfiler; miljön kontrolleras före och efter varje steg. `runtimeHash` ingår tillsammans med `sourceHash` och `assetsHash` när resultat återanvänds. Äldre kandidater utan `runtimeHash` har bara filkontrollen och ska inte betraktas som fullständiga miljöbevis. `--status` skiljer genomförda tester från verkliga skip, avbrutna tester och tester som aldrig kördes. `--workers 1` minskar belastningen och `--prepare-only` tar en kopia utan att köra tester. `BACKEND_PYTHON` väljer Python-miljö som för de vanliga testerna. Imagens acceptans och dokumentationssajten har kvar sina egna kommandon och körs separat.

### Validera en förbättring

Bestäm först vad ändringen ska förbättra och vilket resultat som skulle få oss att avstå. För ett fel räcker ett reproducerat misslyckande och ett test som passerar efter rättningen. För en UX-idé behövs också en jämförelse: exempelvis färre tangentbordssteg, en synlig huvudåtgärd på liten skärm eller mindre risk att förlora en rättning. De första två är indikatorer, inte bevis för att verkliga användare lyckas bättre. Mät en återkommande uppgift med målgruppen när nyttan fortfarande är osäker; gröna tester och en tilltalande bild avgör inte den frågan.

Under iteration används befintliga specar direkt med `--project` och `--grep`, på de tillstånd och gränser som ägaren faktiskt påverkar. `--only-changed` kan inte avgöra vilka UI-tillstånd en ändrad appfil påverkar, eftersom de nås genom webbläsaren. Ett föreslaget smalare urval prövas mot en känd felmutation innan det används som bevis för den klassen av ändringar. Den fullständiga releasekörningen behåller alla profiler och krav.

Mät kostnaden innan arbetsordningen ändras. Playwrights summerade testtider överlappar mellan arbetare; de är inte körningens väggtid. Granska kostnaden per spec och använd vid behov `test.step` för att skilja navigering, väntan och mätningar. En paus kräver ingen ny kandidatkopia om filer, körmiljö och byggda filer är oförändrade: kontrollera ett exakt urval av återstående test-ID:n med Playwrights `--list` före fortsättningen, behåll den avbrutna originalrapporten och verifiera att resultatens union täcker hela ursprungslistan.

## Läsa ett fel

| Det du ser | Betyder | Gör så här |
|---|---|---|
| `targets under 44 px on a coarse pointer (house bar)` | Ett pekmål är för litet | Rätta storleken i temat, inte på ett enskilt ställe. |
| `axe: WCAG violations …` med regel-id och selektor | En axe-överträdelse | `findings.json` för testet har alla noder och förklaringen. |
| `content past the edge or cut off` | Reflow- eller textavståndsfel | Kör läget i projektet som felade (`npm run test:a11y -- a11y.spec.ts -g "<läge>" --project=<projekt>`) och se det i alla storlekar med `npm run ux:shots -- -g "<läge>"`; leta efter en minsta bredd, en fast kolumn eller text som inte får brytas, och kontrollera långa svenska ord. |
| `<sida> loads X KB of JS, the budget is Y KB` | Sidan blev tyngre än budgeten | Hitta importen som växte; höj budgeten bara med skäl. |
| `a <style data-astryx-theme*> means the theme is built in the browser` | Temat byggs i webbläsaren | Importera det byggda temat, `kit/theme/built/eneo`. |
| Konsolfel i ett produktionstest | Oftast en CSP-vägran | Felet anger vilket direktiv som stoppade vad. |

Resultaten finns i `frontend/test-results/a11y/*/findings.json` och i HTML-rapporten (`npx playwright show-report test-results/a11y-report`), där `manual check` listas. Ett spår behålls för misslyckade tester (`npx playwright show-trace <mapp>/trace.zip`). Skärmbilder: `SHOTS=1 npm run test:a11y -- a11y.spec.ts -g "<läge>" --project=phone-390-light` skriver `test-results/shots/<projekt>/<läge>.png`. Se ett enskilt läge i en webbläsare med fönster: `npm run state -- "<läge>"`.

Före och efter en ändring av gränssnittet: `npm run ux:shots` fotograferar varje läge i 23 storlekar (telefoner stående och liggande, surfplattor, 1000 px, laptops och breda skärmar upp till 3840 × 2160) i ljust och mörkt, till `frontend/ux-shots/<etikett>/<läge>/<bredd>x<höjd>-<färgläge>.png` med ett kontaktark, `index.html`. Etiketten är den korta commiten (`-dirty` med ändrade filer), `--name <namn>` lägger till ett namn och `--label <etikett>` sätter den. `--sizes 1000x800,390x844` och Playwrights `-g "<läge>"` smalnar av. `npm run ux:shots -- --compare <före> <efter>` skriver en rapport, `frontend/ux-shots/compare/<före>__<efter>/index.html`, med före, efter och de ändrade pixlarna i rött, de mest ändrade först. Bilderna checkas aldrig in (`ux-shots/` ignoreras).

Varje storlek får också en `.first.png` av det verkliga fönstret. Alla fönsterbilder tas före helsidesbilderna, och skriptet kontrollerar att pekarläget stämmer med enheten. Chromiums helsidesinfångning kan ändra pekskärmsläget och hur fasta lager ritas. Bedöm kontrollstorlek och placering i `.first.png` och med gatens mätningar; helsidesbilden ger sammanhang för resten av sidan.

En ny skärm eller ett nytt överlägg: [Frontend](frontend.md#lägga-till-en-skärm).

Efter en riktad bildkörning i en befintlig bildmapp uppdaterar `npm run ux:shots -- --index <etikett>` kontaktarket utan att ta om bilderna.
