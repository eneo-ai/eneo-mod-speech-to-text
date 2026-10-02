# Kvalitetsgrindar

Syfte: Beskriva alla automatiska kontroller, vad var och en bevisar, hur man kör den och hur man läser ett fel.

Läs detta när: Du ska köra kontrollerna före en push, ett test eller grinden fallerar, du lägger till en skärm eller ett överlägg (dialog, meny), eller en sida blivit för tung.

Hör ihop med: [Frontend](frontend.md), [Designsystem](design-system.md), [Drift](operations.md#ci-och-publicering), [Lokal utveckling](development.md), [Backend](backend.md)

## Översikt

Alla frontend-kommandon körs från `frontend/`, backendens från `backend/`.

| Kontroll | Bevisar | Kommando | Hur lång |
|---|---|---|---|
| Typer | Att koden kompilerar. | `npm run lint` | snabb |
| Enhets- och komponenttester | Logik och komponenter i jsdom. | `npm test` | snabb |
| Backendtester | Inloggning, proxy, uppladdning, filer, live-relä, config. | `.venv/bin/python -m unittest discover -s tests` (från `backend/`) | snabb |
| Tillgänglighetsgrinden | WCAG 2.2 AA och husets krav i en riktig webbläsare, per skärm. | `npm run test:a11y` | lång |
| Grindens branding-tillstånd | Att en organisation med egen accent, långt namn och bred logga klarar samma krav och att inget behåller den blå standardfärgen. | `npm run test:a11y:branding` | medel |
| Produktionssmoke och viktbudget | Det byggda bygget i tre motorer, sidvikt, att det byggda temat används. | `npm run test:prod` | medel |
| Bygget | Att produktionsbygget går att göra. | `npm run build` | medel |
| Designsystemets hälsa | Att Astryx är rätt uppsatt. | `npm run astryx -- doctor` | snabb |
| Temat är aktuellt | Att de byggda temafilerna motsvarar temakällan. | `npm run theme:build && git diff --exit-code -- kit/theme/built` | snabb |
| Compose | Att Compose-filen är giltig. | `docker compose --env-file .env.example config -q` (från roten) | snabb |
| Imagen | Att produktionsimagen går att bygga. | `docker build -t eneo-mod-speech-to-text:test .` (från roten) | medel |

CI kör en delmängd (typer, enhetstester, doctor, temat, audit, bygget, smoke i tre motorer, två av grindens projekt och två av branding-tillstånden, Compose, imagen, och `pip-audit` på backends paket): se [Drift](operations.md#ci-och-publicering). Grinden i sin helhet körs lokalt före push.

## Före en push

```bash
cd frontend
npm ci
npm run lint
npm test
npm run test:a11y          # stoppa din egen npm run dev först, se Portar nedan
npm run test:prod
npm run build
cd ../backend && .venv/bin/python -m unittest discover -s tests
cd .. && docker compose --env-file .env.example config -q
```

Första gången: `npx playwright install chromium` för grinden och `npx playwright install chromium webkit firefox` för `test:prod`.

## Enhets- och komponenttester

`npm test` kompilerar `frontend/lib/*.test.ts` med `tsc` (`tsconfig.test.json`) till `.test-build/` och kör dem med Nodes inbyggda testkörare (`node:test`) i jsdom.

- Logiktester och komponenttester ligger tillsammans i `frontend/lib/`, bredvid logiken. En ny testfil måste ligga där för att köras.
- Köra en fil efter att `npm test` har byggt: `node --require ./tests/register.cjs --test .test-build/lib/<namn>.test.js`.
- jsdom saknar `showModal` och Popover API. `frontend/lib/test-dom.ts` ersätter dem med attribut och händelser, men modalitet och förankring simuleras inte: de är webbläsarens och bevisas i grinden.
- Ett CSS-modulimport i ett test blir ett objekt med klassnamnen som de är skrivna (`frontend/tests/register.cjs`); stilarna är webbläsarens.
- Testkompilatorn läser inte paketens `exports`. En ny Astryx-underväg som inte ligger under `dist/<Namn>` behöver en rad i `paths` i `frontend/tsconfig.test.json`.
- IndexedDB i tester kommer från `fake-indexeddb`.
- `frontend/lib/legacy-ui.test.ts` är en spärr som består: ingen modul importerar det första gränssnittssystemet (de kopierade shadcn-komponenterna, Radix, class-variance-authority, clsx, tailwind-merge, Tailwind) och ingen styr med en klasssträng som `className="…"`. Stilen kommer från designsystemets props eller en CSS-modul (`className={styles.x}`).

## Tillgänglighetsgrinden

`npm run test:a11y` startar stubbackenden (`frontend/tests/e2e/stub-server.py`, bara för test) och `next dev` (`frontend/playwright.config.ts`), och besöker varje skärm och läge i `frontend/tests/e2e/screens.ts` med falsk mikrofon. Inget Eneo behövs. Varje läge är ett namn och stegen som leder dit.

### Vad som mäts

Mätningarna körs i den renderade sidan (`frontend/tests/e2e/checks.ts`) och skrivs till `findings.json` per test.

| Kontroll | Regel | Stoppar grinden när |
|---|---|---|
| axe | WCAG-taggarna för 2.0, 2.1 och 2.2 A och AA samt best practice | varje WCAG-överträdelse, oavsett allvarlighet; övriga regler när de är allvarliga eller kritiska |
| Namn | Varje kontroll har ett namn i Chromiums egna tillgänglighetsträd (WCAG 4.1.2) | en kontroll saknar namn |
| Platshållartext | Kontrast 4,5:1, vilket axe inte mäter (WCAG 1.4.3) | för låg kontrast |
| Målstorlek | 24 px med mus (WCAG 2.5.8), 44 px med finger (`pointer: coarse`, husets krav) | ett mål är mindre |
| Reflow | Inget innehåll utanför kanten eller avklippt, på 320 px, vid 200 % zoom och på laptop- och ultrawide-bredderna (WCAG 1.4.10) | horisontell scroll eller avklippt innehåll |
| Textavstånd | Ökat radavstånd, teckenavstånd och ordavstånd klipper inget (WCAG 1.4.12); en rubrik får inte kapas med ellips. Mäts i de två ljusa telefonprojekten och på laptop- och ultrawide-bredderna | innehåll klipps eller en rubrik kapas |
| Rörelse | Ingen oändlig animation med reducerad rörelse (projektet `reduced-motion`) | en animation fortsätter |
| Tangentbordsvandringar | Fokus syns (en indikator med minst 3:1 förändring), skyms inte, lämnar sidan i slutet (ingen fälla) och ordningen läses uppifrån och ned på telefon (WCAG 2.4.7, 2.4.11, 2.1.2, 2.4.3) | fokus syns inte, skyms eller fastnar |
| ARIA-ögonblicksbilder | Namn, roller, tillstånd och vilken text som når live-regionerna, jämfört med granskade bilder i `frontend/tests/e2e/aria.spec.ts-snapshots/` | bilden ändras utan att den uppdaterats |

### Vilka specar

| Spec | Vad den bevisar |
|---|---|
| `a11y.spec.ts` | Alla mätningarna ovan för varje läge, i varje projekt. |
| `keyboard.spec.ts` | Tangentbordsvandringar och fokushantering i dialoger och kontomenyn. |
| `aria.spec.ts` | ARIA-ögonblicksbilder och texten i live-regionerna. |
| `names.spec.ts` | Namn och beskrivningar för kontroller som kräver mer än axe, grupper och sidtitlar. |
| `harness.spec.ts` | Grindens egna kontroller mot sidor byggda för att fela. En kontroll som släpper igenom dem skulle släppa igenom appens fel. |
| `color-mode.spec.ts` | Att den sparade färgläget är sidans från första målningen, utan en bildruta i fel läge. |
| `session-cover.spec.ts` | Att inget av sidan, och ingen dialog sidan hade öppen, syns eller går att nå medan inloggningen är slut, och att allt är tillbaka efter ny inloggning. |
| `flow-list.spec.ts` | Flödeslistan när den laddar, är tom, avklippt, lång eller trasig. |
| `result-tabs.spec.ts` | Resultatets flikar under laptopbredd. |
| `branding.spec.ts` | En driftsättning med egen accentfärg (grön) och egen organisation: ingenting i sidan behåller den blå standardfärgen och accenten finns från första målningen. Körs bara av `npm run test:a11y:branding` (se nedan). |
| `header-fit.spec.ts` | Toppfältet vid 320 px med ökat textavstånd: varumärket och kontoknappen hålls isär och produktnamnet är helt. |
| `leaks.spec.ts` | Att ett överlägg som öppnas och stängs inte lämnar något kvar, se nedan. |

Specarna `color-mode`, `session-cover`, `flow-list`, `result-tabs`, `header-fit` och `leaks` väljer själva vilka projekt de gäller (överst i varje fil).

### Projekt

Konfigurationen (`playwright.config.ts`) har 19 projekt. `a11y.spec.ts` körs i alla; vad mer som körs styrs av `testIgnore`.

| Projekt | Skärm | Särskilt | Vad som körs |
|---|---|---|---|
| `phone-320-light`, `phone-320-dark` | 320 × 568 | pekskärm | ljus: a11y och keyboard; mörk: a11y |
| `phone-390-light`, `phone-390-dark` | 390 × 844 | pekskärm | ljus: alla specar; mörk: a11y |
| `tablet-portrait`, `tablet-landscape` | 768 × 1024 och 1024 × 768 | pekskärm | a11y |
| `laptop-1280-light`, `laptop-1280-dark` | 1280 × 800 | | ljus: a11y och keyboard; mörk: a11y |
| `laptop-1440-light`, `laptop-1440-dark` | 1440 × 900 | | ljus: alla specar; mörk: a11y |
| `zoom-200` | 640 × 400, skala 2 | 200 % zoom av 1280 × 800 | a11y och keyboard |
| `forced-colors` | 1440 × 900 | tvingade färger | a11y och keyboard |
| `ultrawide-1920-light`, `-dark` | 1920 × 1080 | | ljus: a11y och keyboard; mörk: a11y |
| `ultrawide-2560-light`, `-dark`, `ultrawide-3440-light`, `-dark` | 2560 × 1440 och 3440 × 1440 | | a11y |
| `reduced-motion` | 390 × 844 | reducerad rörelse, pekskärm | a11y |

På 1280, 1920, 2560 och 3440 px körs alla kontroller per skärm i ljust och mörkt; tangentbordsvandringarna och dialogernas fokustester körs på 1920 px, eftersom tangentbordsordning och fokushantering inte ändras på bredare skärmar.

### Branding-tillstånden

`npm run test:a11y:branding` (från `frontend/`) kör samma grind mot en stub som startas som en annan organisation: en grön accent, ett långt namn och breda eller inga logotyper. Det görs i två körningar (`STUB_BRANDING=custom` och `STUB_BRANDING=name`) med `frontend/playwright.branding.config.ts`, som bara tar tillstånden som heter `branding-` i `frontend/tests/e2e/screens.ts` och projekten `phone-320-light`, `phone-390-dark`, `laptop-1440-light`, `zoom-200` och `forced-colors`. Skälet är att sidan läser organisationen från backend på servern: det är stubben som startas som organisationen, inte sidan som ändras. En stub som redan lyssnar på porten avvisas hellre än att inget testas. Steg för att kontrollera en egen organisation: [Byt organisation](branding.md#så-kontrollerar-du).

### Köra delar

```bash
# En skärm, smalast och mörkt, medan du bygger den
npm run test:a11y -- a11y.spec.ts -g "<läge>" --project=phone-320-light --project=laptop-1440-dark
# Ett läge i alla projekt
npm run test:a11y -- -g "<läge>"
# Grindens egna kontroller, färgläget och täckskiktet
npm run test:a11y -- harness.spec.ts color-mode.spec.ts session-cover.spec.ts
# Efter en avsiktlig ändring av vad skärmläsaren får, för det läget
npm run test:a11y -- aria.spec.ts --update-snapshots -g "<läge>"
```

Läs diffen på ögonblicksbilderna innan du behåller dem.

### Vad grinden inte bevisar

- **Vad en skärmläsare faktiskt läser upp.** Grinden bevisar DOM:en och den renderade sidan: roller, namn, tillstånd, fokus, kontrast, layout och vilken text som hamnar i live-regionerna. Skärmläsaren är en manuell kontroll, liksom det axe inte kan avgöra själv (axe:s _incomplete_, listade som `manual check` i rapporten och i `findings.json`).
- **PDF-förhandsvisningen.** Den visar PDF:en i webbläsarens egen visare, där en sida inte kan fånga Escape. Grinden kräver därför att visaren inte stänger in fokus: antingen är den inget tabbstopp och dialogen har en länk som öppnar filen i en ny flik, eller så leder Tab ut ur visaren tillbaka till dialogens kontroller och visaren visar synligt fokus. Escape ska stänga dialogen från dialogens egna kontroller; Escape inifrån visaren krävs inte.
- **Webbläsare utan förankrade menyer** (Safari 17 till 25, Firefox före 147) och riktiga enheter: menyer och väljare öppnas och stängs men placeras inte vid sin utlösare. Kontrolleras för hand en gång per release på en riktig enhet.
- **Tidsgränser (WCAG 2.2.1).** Se [Inloggning och session](auth-and-session.md#tidsgränser-wcag-221).

### Regler som aldrig ändras

Sänk inte ett tröskelvärde, ta inte bort ett läge ur grinden och lägg inte till ett axe-undantag för att få grinden grön. Hitta orsaken i stället; en brist i designsystemet rättas en gång i temat ([Designsystem](design-system.md#rätta-en-brist-i-designsystemet)).

## Produktionssmoke och viktbudget

`npm run test:prod` bygger produktionsbygget och serverar det som imagen gör (`frontend/tests/prod/serve.mjs`, `frontend/playwright.prod.config.ts`), mot stubbackenden, i Chromium, WebKit och Firefox. Det bevisar det som grindens `next dev` inte kan: de byggda stilarnas ordning, det byggda temat och sidan under produktions-CSP:n. Bygget görs med `FOUNDATION_CHECK=1`, så att utvecklingssidan `/dev/foundation` finns för testerna.

| Test | Bevisar |
|---|---|
| `smoke.spec.ts` | Att designsystemet är stylat, tematiserat och fungerar i det byggda bygget, och att en inloggad sida laddar utan blockerat eller trasigt innehåll (en CSP-vägran är ett konsolfel). |
| `weight.spec.ts` | Att en sidas komprimerade JS och CSS inte överstiger `tests/prod/weight-budget.json`, och att det byggda temat används: inget `<style data-astryx-theme*>` får finnas efter laddning (det vore runtime-generering av tema vid varje sidladdning). Bara Chromium, som rapporterar överföringsstorlek. |

`frontend/tests/prod/branding.spec.ts` kör accentens stilmall i det byggda bygget, också under en strikt `style-src 'self'`, och körs bara när stubben är en organisation med egen accent: `STUB_BRANDING=custom npm run test:prod -- branding.spec.ts --project=chromium`.

### Viktbudgeten

- Budgeten (`frontend/tests/prod/weight-budget.json`) ger ett tak i KB för JS och CSS per sida: den uppmätta vikten avrundad uppåt till närmaste 5 KB.
- En ändring som höjer den motiverar det i sin pull request. Budgeten mäts på ett bygge som också innehåller utvecklingssidan, vilket flyttar delade bitar något; detaljerna står överst i `weight.spec.ts`.
- Ladda inget sidan inte använder: importera en språkfil, ikonuppsättning eller komponent där den används, inte via en gemensam samlingsfil. Kör `weight.spec.ts` efter att ha lagt till en import från `@astryxdesign/core`.

## Läckkontrollen

`frontend/tests/e2e/leaks.spec.ts` öppnar och stänger varje överlägg 40 gånger och jämför Chromiums egna räknare (DOM-noder, händelselyssnare, minne) efter skräpsamling, före och efter. Ett läckage växer med varje varv och skulle synas som ungefär 40.

- Fem uppvärmningsvarv räknas inte (en portal, en lat bit, en cache, webbläsarens eget).
- Tillåten marginal för de 40 öppningarna sammanlagt: 20 noder, 20 lyssnare, 1,5 MB minne. Det höjs aldrig för att få ett test att passera; ett tal över är ett läckage att hitta.
- Körs bara i `laptop-1440-light`, bara i Chromium, utan trace (trace lägger egna noder på sidan).
- Chromium behåller elementet som senast låg under pekaren, och allt som togs bort med det (25 till 39 noder för en dialog), tills pekaren flyttas. Specen flyttar därför pekaren bort efter varje stängning; ett tal som överlever det är ett riktigt läckage att hitta.
- Ett av överläggen läcker med avsikt (fixturen i `frontend/app/dev/dialog-leak/`, bara i `next dev`), så att specen visar att den kan fela.
- Ett nytt överlägg läggs till i `OVERLAYS` i samma ändring som inför det.

```bash
npm run test:a11y -- leaks.spec.ts --project=laptop-1440-light
```

## Portar och flera utcheckningar

| Kontroll | Standardportar (app, stub) | Ändra med |
|---|---|---|
| `npm run test:a11y`, `npm run dev:stub` | 3401, 8401 | `A11Y_APP_PORT`, `A11Y_STUB_PORT` |
| `npm run test:prod` | 3411, 8411 | samma två variabler |

- Flera utcheckningar (git worktrees) kan köra grinden samtidigt på egna portpar, till exempel `A11Y_APP_PORT=3464 A11Y_STUB_PORT=8464 npm run test:a11y -- ...`.
- Next tillåter en utvecklingsserver per utcheckning: stoppa din egen `npm run dev` i samma utcheckning först.
- Grinden kör fyra arbetare mot den enda utvecklingsservern; fler svälter den på en delad maskin, och en sida som fortfarande laddar felar då en kontroll som inte handlar om tillgänglighet.
- Döda aldrig en process du inte startat och använd aldrig `pkill -f`: stoppa det du startat via dess PID eller port.

## Läsa ett fel

| Det du ser | Betyder | Gör så här |
|---|---|---|
| `targets under 44 px on a coarse pointer (house bar)` | Ett pekmål är för litet | Listan nämner elementet. Rätta storleken i temat, inte på ett enskilt ställe. |
| `axe: WCAG violations …` med regel-id och selektor | En axe-överträdelse | Öppna `findings.json` för testet: den har alla noder och förklaringen. |
| `content past the edge or cut off` | Reflow- eller textavståndsfel | Kör samma läge i `phone-320-light` och `zoom-200`. Kontrollera långa svenska ord och långa flödesnamn. |
| `<sida> loads X KB of JS, the budget is Y KB` | Sidan blev tyngre än budgeten | Hitta importen som växte; höj budgeten bara med skäl. |
| `a <style data-astryx-theme*> means the theme is built in the browser` | Temat byggs i webbläsaren | Importera det byggda temat, `kit/theme/built/eneo`. |
| Knappen utan stoppning, eller annan accentfärg än blå i smoke | Ett förlorat cascade-skikt eller ett tema som inte laddats | Kontrollera importordningen i `frontend/app/layout.tsx` och `frontend/app/layers.css`. |
| Konsolfel i `smoke.spec.ts` | Oftast en CSP-vägran | Läs felet: det anger vilket direktiv som stoppade vad. |

Var resultaten finns:

- `frontend/test-results/a11y/*/findings.json`: mätvärden per läge och projekt.
- `frontend/test-results/a11y-report`: HTML-rapporten (`npx playwright show-report test-results/a11y-report`), där `manual check` listas som kommentarer.
- Ett spår behålls för misslyckade tester: `npx playwright show-trace <mapp>/trace.zip`.
- Skärmbilder: `SHOTS=1 npm run test:a11y -- a11y.spec.ts -g "<läge>" --project=phone-390-light --project=laptop-1440-dark` skriver `test-results/shots/<projekt>/<läge>.png`. Skärmbilder behålls också vid fel.
- Se ett enskilt läge i en webbläsare med fönster: `npm run state -- "<läge>"`.

## Lägga till en skärm eller ett överlägg

1. Lägg lägen för skärmen i `frontend/tests/e2e/screens.ts` (ett namn och stegen dit). `a11y.spec.ts` besöker dem automatiskt i alla projekt.
2. Behöver den en tangentbordsvandring eller en ARIA-ögonblicksbild, lägg den i `keyboard.spec.ts` respektive `aria.spec.ts`.
3. Är det ett överlägg (meny, väljare, dialog, bottenark), lägg det i `OVERLAYS` i `leaks.spec.ts`.
4. Kör läget i `phone-320-light` och `zoom-200` före hela grinden.
5. Hur en ny skärm byggs i övrigt: [Frontend](frontend.md#lägga-till-en-skärm).

## Migration (temporary, removed by bead .24)

- Planens regler för grinden finns i `docs/plans/2026-10-01-astryx-port-plan.md`.
