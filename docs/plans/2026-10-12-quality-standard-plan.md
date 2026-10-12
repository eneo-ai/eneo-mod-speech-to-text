# Kvalitetsstandard: enheter, webbläsare, QoL och kitet

Datum: 2026-10-12. Planeringsdokument för tal till text (epik `stt-5db`) och, i sin tur, för `eneo-module-kit`.
Tas bort med byggställningen (bead `stt-plan-a-astryx-port-57a.24`); det permanenta innehållet hamnar i
`docs/quality-gates.md` och i kitets `docs/`. Granskad av Codex Astra (xhigh): session `stt-device-tests` pass 1 (6)
och pass 2 (7, "fyra avgränsade rättelser, ingen fler bred runda"), session `stt-quality-standard` pass 1 (7).
Rättelserna är inarbetade; inga fler granskningsrundor före arbetspaketen.

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

Kitets beslut står: K1 (mallen kopierar, paketen importeras), K12 (`AGENTS.md`, pinnad Astryx-CLI, inga egna
MCP-servrar). Kitplanens fas 3 kopierar redan gaten till mallen; det som ändras:

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
- Tal till text är referensen; modulen byter till paketet när kitet 0.1.0 är släppt och `gwh.3` öppnas igen.

## 5. QoL-paketet

Regel: Astryx-props först, temat för en systembrist, CSS-modul bara i bespoke-ytor; varje ändring med
`ux:shots --compare` före/efter, gaten och controls gröna på berörda lägen, detektorn på ändrade filer. Verifierade
förbättringar, inte varje fynd: av de första sex ströks tre som avsiktliga (hastighetsknappen ovanför spelaren på
telefon, filnamnsbrytningen, resultatets bredd på iPad), och listradernas 8 px inset är designsystemets.

Slice 1 (bead `stt-0p3`, gren `fix/qol-layout`): formulärets breddtak bara i tvåkolumnsläget så ljudblocket slutar
där deltagarfältet slutar (768, 844, 1000); mikrofonväljaren fyller raden på telefon (bred iPhone 440 px) och står
bredvid knappen från 768; liggande telefon får en vänsterkolumn som rymmer namnet och väljaren på en rad; "tar längre
tid"-meddelandet står överst när ett flöde laddar långsamt. Slice 2 (bead `stt-8la`): replikrader, inspelningens
tidsvarningar, utloggad under inspelning, resultatets verktygsfält ≥ 1024, filnamnsraden. Slice 3: talargranskningens
editor (bakom flagga), inloggningssidans kolumn, laddnings-spinnern, deltagarchips, "Ta bort" på klar-panelen.

## 6. Arbetspaket (Beads, epik `stt-5db`)

| Bead | Paket | Bevis |
|---|---|---|
| `stt-0p3` | QoL slice 1 | före/efter, gaten, controls, detektorn |
| `stt-tgw` | WebKit och Firefox i gaten som harness-anpassning, `tap()` på touch, mediastart per motor, CI-listor | tre motorer gröna; negativa fixturer faller i varje motor |
| `stt-pyq` | Surfplatta tangentbord + controls, liggande telefon | nya projekt gröna, tid mätt |
| `stt-c1d` | iOS-resan mot riktig BFF, avbrott under inspelning, MP4, standalone, filväljare, filmetadata i stubben | JUnit, spelbar inspelning med längd |
| `stt-5ik` | Android-resan via `adb reverse` | samma påståenden |
| `stt-daw` | Releaseregel och macOS-jobb efter en obevakad körning | ett grönt obevakat kvitto |
| `stt-8la` | QoL slice 2 | som slice 1 |
| `stt-3y1` | Kitet: testad delmängd, `quality.md`, K12-ändring, tunn skill | mallens gate grön utanför arbetsytan |

Ordning: `stt-0p3` → `stt-tgw`/`stt-8la` → `stt-pyq` → (första driftsättningen) → `stt-c1d` → `stt-5ik` →
`stt-daw` → `stt-3y1` när kitets fas 2–3 byggs.
