# Kvalitetsstandard: enheter, webbläsare, QoL och kitet

Datum: 2026-10-12. Planeringsdokument för tal till text (epik `stt-5db`) och, i sin tur, för `eneo-module-kit`.
Tas bort med byggställningen (bead `stt-plan-a-astryx-port-57a.24`); det permanenta innehållet hamnar i
`docs/quality-gates.md` och i kitets `docs/`. Granskad av Codex Astra (xhigh): session `stt-device-tests` pass 1 (6)
och pass 2 (7, "fyra avgränsade rättelser, ingen fler bred runda"), session `stt-quality-standard` pass 1 (7).
Rättelserna är inarbetade; inga fler granskningsrundor före arbetspaketen. Kitöverföringen och de nya kontrollerna
granskades 2026-10-13 av Codex (GPT-6.1-Sol, high): session `kit-carry-over` pass 1 (7); rättelserna står i avsnitt 3 och 4.

Driftsättningen av `v0.1.1` på `a0272ad` (`docs/plans/2026-10-12-production-readiness.md`) villkoras inte av något
här.

## 1. Vad som finns och vad som saknas

Gaten (`frontend/playwright.config.ts`, 199 tester, 89 lägen i `tests/e2e/screens.ts`) mäter per läge och bredd:
axe, namn, platshållarkontrast, målstorlek 24/44 px, reflow, textavstånd, rörelse, tangentbordsvandring,
ARIA-ögonblicksbilder, och trycker på varje kontroll (`controls.spec.ts`). Produktionstesterna kör Chromium, WebKit
och Firefox vid 1280 × 800 med mus. `ux:shots` fotograferar 23 storlekar. `verify:candidate` kör hela matrisen på en
skrivskyddad kandidat.

| Lucka | Bevis |
|---|---|
| Gaten kör bara Chromium; iPhone och iPad (WebKit) ses aldrig vid telefon- eller surfplattebredd, aldrig med touch | `playwright.config.ts` projekten |
| Surfplattan är bara skanning (`scanOnly`); ingen tangentbordsvandring, inga controls | `playwright.config.ts:85` |
| `controls.spec.ts` trycker med musen (`click()`), inte touch (`tap()`), och faller tillbaka på fokus + Enter för varje kontroll som inte går att klicka | `controls.spec.ts:291` |
| Ingen riktig enhet: mikrofonfrågan, iOS-tangentbordet, filväljaren, hemskärmsapp, omstart | – |
| CI kör två projekt (`ci.yml:118`); releasen kontrollerar imagen, inte testurvalet eller enhetskvitton (`release.yml:34`); `verify:candidate` skriver `passed` också för ett smalnat urval (`verify-candidate.mjs:237`) | – |
| Ingen PWA-hållning (ingen manifest, service worker eller `apple-mobile-web-app-*`) | `index.html` |

## 2. Bevisat 2026-10-12 på riktiga motorer (T3:s enhetspanel, `agent-device` 0.21.25, MIT)

| | iPhone 18 Pro Max, iOS 27 Safari | iPad Pro 11, iOS 27 | Pixel 9, Android 16, Chrome |
|---|---|---|---|
| Inloggad lista, konto-meny, tema | ja | ja | ja |
| Deltagare via systemets tangentbord | ja | – | – |
| Mikrofonfrågan | systemalert, godkänd | – | Chromes fråga + Androids behörighet, godkända |
| Inspelning, paus, fortsätt, stopp, uppspelning | ja, 0:31 | – | ja, 0:08 |
| "Skapa dokument", resultat, PDF-länkar, transkribering, Rätta, Ändra talare | ja | ja | – |
| Filväljaren | – | iOS-arket öppnas (Photo Library / Take Video / Choose File) | – |
| Säker kontext | `127.0.0.1` | `127.0.0.1` | `10.0.2.2` är **inte** säker: appen visar korrekt "kräver https och en mikrofon" och erbjuder uppladdning; `adb reverse tcp:<port>` + `localhost` ger inspelning |

Olöst: simulatorns inspelning nådde stubben som 217 byte för 31 s. Avgörs inte med en bytegräns: filen sparas,
avkodas och spelas, och upprepas med hörbar insignal (WP4); fysisk enhet i bead `.8`. XCTest-trädet visar lägesvalen
som `other`, men WebKit exponerar `radiogroup`/`radio` korrekt (verifierat med Playwright-WebKit); inget fel.

## 3. Strategi

**Lager 1, varje pull request, Linux-CI, Playwright.** Motorerna är motorkontroller, inte produktwebbläsare
(Playwrights WebKit ligger före Safari, Chromium skiljer sig från Chrome och Edge i kodekar och policy); produkt-
webbläsarnas acceptans står kvar i driftchecklistan.

| Mätning | Chromium | WebKit | Firefox |
|---|---|---|---|
| axe, kontrast, målstorlek, reflow, textavstånd, rörelse, tangentbordsvandring | ja | ja | ja |
| ARIA-ögonblicksbilder (`toMatchAriaSnapshot`, semantik, inte VoiceOver) | ja | ja, egna bildfiler | ja, egna |
| Namn i webbläsarens träd, `axNode`, läckor (CDP) | ja | – | – |
| Stilla sida: inget på skärmen flyttar sig när ett svar kommer (`still.spec.ts`) | ja | inte påslagen (tekniken är portabel) | inte påslagen |
| Varje kontroll: `tap()` på touch-projekt, `click()` på mus, fokus + Enter bara för deklarerat tangentbordsenbara | ja | ja | ja |
| Inspelning | ja | macOS ja, Linux nej: uppladdning-utan-inspelning är ett eget förväntat läge; saknas inspelning där den ska finnas faller testet | ja (Firefox saknar `microphone`-behörighet i Playwright: egen mediastart) |

- Projekt: `phone-390-webkit`, `tablet-landscape-webkit`, `laptop-1440-webkit`, `laptop-1440-firefox`; Edge och
  Safari på macOS har inga egna projekt. Projektnamnsfiltren i `controls.spec.ts:22`, `a11y.spec.ts:35`,
  `harness.spec.ts:9` byts mot val per motor och förmåga; vaktposten (`sentinel.ts:75`) lär sig motorernas
  avbrottssträngar. Surfplattan får tangentbord och controls; liggande telefon 844 × 390 som skanning.
- Negativa fixturer per motor: ett skymt huvudkommando, en kontroll som svarar på mus men inte touch, ett trasigt
  fokus, en för liten yta; varje ny motor ska se dem falla.
- CI: `ci.yml` namnger projekten; varje PR kör Chromium som i dag plus `phone-390-webkit` och `laptop-1440-firefox`
  på de portabla specarna. "Hela matrisen" definieras uttryckligen (vilka projekt, vilka specar) och körs av
  `verify:candidate` på releasekandidaten; tid mäts innan ett nattjobb bestäms. Inga pixel-ögonblicksbilder i CI.
- Stilla sida (`still.spec.ts`, PR 29): varje sida öppnas via sin adress och får modulens svar ett i taget, i den
  ordning den bad om dem; kontroller, rubriker och text mäts före och efter varje svar på telefon, surfplatta och
  laptop. Deterministisk: tre körningar och en med varje svar 300 ms sent gav samma resultat. Ett svep över lägen
  som nås med tryckningar gav inte samma resultat två gånger; tryckningar får riktade tester som håller ett svar
  (`preview-actions.spec.ts`). Kvarvarande flyttar står med skäl och ärende i specens `KNOWN`.
- Verktyg: `GATE_CPU=<gånger>` stryper sidans CPU i Chromium så att en kapplöpning som bara CI förlorar går att
  återskapa (läcktestets Escape före `showModal()` föll två PR:er 2026-10-12); `npm run ci:failure -- <PR>` läser
  ett rött CI-jobb lokalt. En strypt körning är diagnostik tills dess tid och pålitlighet är mätt; ingen nattkörning.

**Lager 2, per release, riktig Safari och Chrome på simulator och emulator, ett verktyg.** `agent-device` som
`.ad`-skript i `frontend/tests/device/`, mot det byggda gränssnittet + riktig BFF + stubben som Eneo (samma stack som
`test:a11y:real`), iOS via `127.0.0.1`, Android via `adb reverse` och `localhost`:
logga in → flöde → deltagare med systemets tangentbord → mikrofonfråga → spela in → **bakgrund och tillbaka, och
omstart av webbläsaren under pågående inspelning** → fortsätt, stoppa → spelbar inspelning med avkodad längd → "Lägg
till på hemskärmen", start därifrån, inloggning och inspelning i standalone → logga ut, logga in, inspelningen kvar →
filväljaren med en riktig fil → resultat, PDF → logga ut → bakåt. MP4 testas avsiktligt. Samma påståenden på båda
plattformarna; om samma skript räcker avgörs när Android-resan gått. Lägen som gaten når genom nätverksinfång eller
API-patchar stannar i Playwright. Filbevis: stubben loggar filpartens namn, MIME och byte (i dag bara antal och
totalbyte). Selenium/safaridriver, Appium och Maestro är reserver.

**Releaseregel** (ersätter "när `xcrun` finns"): tills WP7 är enhetsresan rådgivande och ingen varje-release-garanti
utlovas. Från WP7 kräver utgåvan ett godkänt enhetskvitto och det fullständiga testurvalet för exakt den taggade
commiten och imagens digest; saknat, delvis, skippat eller "ej stödd" bevis stoppar kopieringen. Ett smalnat
utvecklingsurval är fortfarande giltigt för utveckling, bara inte som releasebevis. Varje utgåva får ett kort
acceptansprotokoll (artefakt, automatiska resultat, manuella webbläsar- och tillgänglighetskontroller, godtagna
undantag, återgång) i befintliga `docs/operations.md`, ingen ny checklista.

**Lager 3, före release:** kort checklista för Safari-specifika risker på ändrade ytor (viewport och verktygsfält
med tangentbordet öppet, MIME, IndexedDB-återhämtning, bfcache på inloggningssidan, filväljare och nedladdning), i
`docs/quality-gates.md` under "Enheter". Bead `.8` (fysisk Safari 17/18 mot domänen) står kvar; stödnivån för Safari
17/18 är ett ägarbeslut.

**PWA.** Nu: standalone-steget i resan (Safari 26 öppnar varje sajt som hemskärmsapp; egen lagring, dokumenteras,
lovas inte bort). Ägarbeslut: manifest, ikoner och `display` för en vald presentation. Ingen service worker utan
offline-krav; ingen Lighthouse-grind (PWA-kategorin är borttagen).

## 4. Standard för kommande moduler (kitet)

Kitets läge (`origin/main` `8432c0b`, läst 2026-10-13): båda paketen (`packages/bff`, `packages/ui` med skal,
branding, färgläge, sessionsklient och täckningen vid utgången inloggning), mallen med egen gate
(`template/web/tests/e2e`: a11y, tangentbord, harness, header-fit, session-cover, tema och flöde; åtta
Chromium-projekt och flöde plus session-cover i WebKit och Firefox; alltid den byggda appen på riktig BFF över en
stubbe), en skill (`template/.agents/skills/eneo-module`, beslut K17 ersätter K12:s "ingen skill") och CI. Version
0.1.0 är inte släppt; publicering kräver ägarens go och registeråtkomst. UI-paketet har ingen onlinestatus,
offline-notis eller navigeringsspärr.

Kitets gate är en äldre delmängd av modulens. Överföringen görs i två delar:

- **Del 1** (kit-ärende `kit-module-kit-ojs.29`, gren `feat/quality-tools`), oberoende av motorarbetet: CI sparar
  JSON-rapport och testresultat vid fel, `ci:failure`, `GATE_CPU`, modal dialog före Escape (kitets tre
  Escape-tryckningar väntar inte på det, och en går igenom av fel skäl), `still.spec.ts` för mallens sidor,
  `docs/guides/quality.md`.
- **Del 2**, när modulens gate är fryst (PR 29 och `test/gate-engines` inne): rättelserna i `checks.ts`,
  harnessens självtester, vaktposten utöver konsol och CSP, svepet över alla kontroller, ARIA-bilder med skyddet
  mot överskrivning, surfplatta och liggande telefon, `ux:shots`.

Beslut som står: K1 (mallen kopierar, paketen importeras), K12 med K17 (`AGENTS.md`, pinnad Astryx-CLI, en lokal
skill, inga egna MCP-servrar). Det som gäller för överföringen:

- **Kopiera en testad delmängd, inte tre filer och inte hela harnessen.** Inventera först vad som är modul-ägt
  (ARIA-regioner och inspelningsuppläsningar i `aria.spec.ts:15`, överläggen i `leaks.spec.ts:33`, `NO_RESPONSE` i
  `controls.spec.ts:39`, harnessens självtest mot spelaren `harness.spec.ts:159`, `frontend/`-sökvägar och
  granskningssviter i `verify-candidate.mjs:251`). Det generiska (`checks.ts`, `gate.ts`, `sentinel.ts`, `a11y`,
  `keyboard`, `controls`, `aria`, `shots`, `ux-shots.mjs`, projektmatrisen, CI-mallen) följer med, körs mot mallens
  fem lägen, verifieras utanför arbetsytan, med källrevision antecknad och en ägare för att föra rättelser vidare.
  Ingen `defineGate`-signatur förrän en andra modul visar gränsen (samma trigger som `gwh.3`).
- **Skill:** K12 ändras uttryckligen på grunden "procedurer är svåra att hitta": regler i `AGENTS.md`, en tunn
  `module-quality`-skill (`.claude/skills/`, länkad från `AGENTS.md`) som pekar på `quality-gates.md` och säger i vilken
  ordning man kör gaten, enhetsresan, bilderna och kandidaten. Den läggs till först när en agent utan kontext visats
  behöva den; tal till text är provet.
- **MCP:** inga inaktiva `.mcp.json`-poster. Dokumentera valfria uppsättningar (Astryx hosted MCP, `agent-device mcp`)
  i `docs/guides/local-development.md`. Impeccable-detektorn är ägarens verktyg, inget krav på en modul.
- **Efter granskningen 2026-10-13:** `packages/ui` får bara generell presentation och sessionsbeteende.
  Navigeringsspärren (`useLeaveQuestion` importerar React Router; kitets UI-paket är routerfritt), löften om
  inspelningar, uppladdningar och körningar och modulens texter stannar i modulen; onlinestatusen ligger bredvid
  sessionspaketets anropsfunktion, i en instans. Delmängden som kopieras namnger sina beroenden (`gate.ts` behöver
  `auth.ts`, `controls.spec.ts` behöver `controls.ts`, `ux-shots.mjs` sin bildkonfiguration och spec) och tar med
  självtesterna (`harness.spec.ts`, `sentinel.spec.ts`): en grön mall med fem lägen bevisar inte att en kontroll
  kan falla. En sammanslagen revision fryses innan kopieringen. Rutiner står i `docs/quality.md`; skillen länkar
  och ordnar dem. Enhetsresan är inte kitvägledning förrän det finns körbara skript och kvitton (`stt-c1d`).
- Tal till text är referensen; modulen byter till paketet när kitet 0.1.0 är släppt och `gwh.3` öppnas igen.

## 5. QoL-paketet

Regel: Astryx-props först, temat för en systembrist, CSS-modul bara i bespoke-ytor; varje ändring med
`ux:shots --compare` före/efter, gaten och controls gröna på berörda lägen, detektorn på ändrade filer. Verifierade
förbättringar, inte varje fynd: av de första sex ströks tre som avsiktliga (hastighetsknappen ovanför spelaren på
telefon, filnamnsbrytningen, resultatets bredd på iPad), och listradernas 8 px inset är designsystemets.

Slice 1 (bead `stt-0p3`, gren `fix/qol-layout`, PR 26): formulärets breddtak bara i tvåkolumnsläget så ljudblocket
slutar där deltagarfältet slutar (768, 844, 1000); mikrofonraden mäter sig själv (container query vid 36 rem): väljaren
fyller raden under det och står bredvid knappen från det; liggande telefon får en vänsterkolumn på en tredjedel av
bredden upp till 17 rem; "tar längre tid"-meddelandet står överst när ett flöde laddar långsamt; gate-projektet
`landscape-844`.

Slice 2 (bead `stt-8la`, gren `fix/qol-slice-2`): under fem minuter kvar till flödets maxlängd är en varning ovanför
Pausa och Stoppa (femton minuter är kvar som lugn rad, och radernas brytning är balanserad); "Stoppa" är sekundär i
dialogen "Du behöver logga in igen", så "Logga in igen" är den enda fyllda knappen; från 1024 står dokumentets
nedladdning på filens egen rad när dokumentet inte har egen text, som raderna under "Fler filer". Lämnade efter
läsning av koden: "Rätta" flyter avsiktligt efter repliken som ett ord (`TranscriptPlayer.tsx`, kommentaren vid
knappen), och ett filnamn som bryts vid datumets bindestreck bryts på ett naturligt ställe.

Stabilitet (PR 28 och 29): en modul som svarar är online även när webbläsaren säger offline (iOS Safari och Android
Chrome efter att värddatorn sovit); "Dela" har sin plats från första ritningen och är avstängd tills filen är läst
(dokumentet hoppade 52 px på 390 px bredd); en pågående körning som öppnas via adress väntar in sina uppgifter
(72 px); felsidans transkribering står sist, efter "Kontakta support" (435 till 487 px).

Slice 3: talargranskningens editor (bakom flagga), inloggningssidans kolumn, laddnings-spinnern; talarlistan på
granskningssidan väntar in rättningarna (`stt-5db.1`) och notisen om äldre dokument (`stt-5db.2`). Strukna efter
bild: deltagarchipsen står redan bredvid varandra, "Ta bort" på klar-panelen har designsystemets ghost-inset, och
knapparna under vikningen på liggande telefon når man med en rullning.

## 6. Arbetspaket (Beads, epik `stt-5db`)

| Bead | Paket | Bevis |
|---|---|---|
| `stt-0p3` | QoL slice 1 (PR 26) | före/efter, gaten, controls, detektorn |
| `stt-tgw` | WebKit och Firefox i gaten som harness-anpassning, `tap()` på touch, mediastart per motor, CI-listor | tre motorer gröna; negativa fixturer faller i varje motor |
| `stt-pyq` | Surfplatta tangentbord + controls, liggande telefon | nya projekt gröna, tid mätt |
| `stt-c1d` | iOS-resan mot riktig BFF, avbrott under inspelning, MP4, standalone, filväljare, filmetadata i stubben | JUnit, spelbar inspelning med längd |
| `stt-5ik` | Android-resan via `adb reverse` | samma påståenden |
| `stt-daw` | Releaseregel och macOS-jobb efter en obevakad körning | ett grönt obevakat kvitto |
| `stt-8la` | QoL slice 2 (PR 27), stabilitet (PR 28), stilla sida och verktyg (PR 29) | som slice 1; `still.spec.ts` faller på båda rättelserna när de tas bort |
| `stt-3y1` | Kitet: testad delmängd, `quality.md`, K12-ändring, tunn skill | mallens gate grön utanför arbetsytan |

Ordning: `stt-0p3` → `stt-tgw`/`stt-8la` → `stt-pyq` → (första driftsättningen) → `stt-c1d` → `stt-5ik` →
`stt-daw` → `stt-3y1` när kitets fas 2–3 byggs.
