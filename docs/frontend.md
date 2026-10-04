# Frontend

Gränssnittet är en React-app med Vite, react-router och designsystemet Astryx. Den byggs till statiska filer som backenden serverar ([Backend](backend.md#statiska-filer-och-säkerhetsheaders)). All text användaren läser är svenska.

## Lager

| Sökväg | Innehåll |
|---|---|
| `frontend/main.tsx`, `frontend/routes.tsx` | Ingången och routetabellen: `/` (inloggning), `/flows` (flödeslistan), `/flows/:id` (ett flöde: inmatning, körning, resultat), `/inloggad` (sidan som förnyelsefönstret visar). Varje sidas kod hämtas när routen först besöks. |
| `frontend/routes/` | Sidorna, `Root.tsx` (providers och ram) och `RouteEffects.tsx`. `routes/dev/` är utvecklingssidor, se [Byggen](#byggen). |
| `frontend/components/` | Skärmar och ytor. `components/flow/` är flödessidans delar. |
| `frontend/kit/` | Tema, providers och skal: `ModuleProviders`, `ModuleShell`, `ColorModeProvider`, `RouterLink`, `theme/`. Importerar inget från `routes/`, `components/` eller `lib/`. |
| `frontend/lib/` | Logik utan gränssnitt, ett ansvar per fil, med testerna bredvid (enhets- och komponenttester ligger tillsammans här). Importerar ingen UI-kod. |
| `frontend/styles/` | Skiktordningen (`layers.css`) och modulens egna stilar (`globals.css`). |
| `frontend/public/` | Filer som kopieras oförändrade: Sundsvalls logotyp, live-ljudets AudioWorklet (`live-pcm-worklet.js`) och skriptet för första målningen (`color-mode.js`). |
| `frontend/scripts/finish-build.mjs` | Avslutar bygget, se [Byggen](#byggen). |
| `frontend/tests/` | Gaten (`e2e/`), produktionstesterna (`prod/`) och fixturer. Se [Tester](quality-gates.md). |

Tillåtna importriktningar: `routes/` och `components/` får importera `kit/`, `lib/` och Astryx; `kit/` bara Astryx; `lib/` ingen UI.

## Byggen

| Kommando (från `frontend/`) | Resultat |
|---|---|
| `npm run build` | Typkontroll, `vite build` och `scripts/finish-build.mjs`: skriptet för första målningen får ett innehållsnamn under `assets/`, sidans enda organisationsmarkör kontrolleras, och en `.br`- och en `.gz`-fil skrivs bredvid varje fil som kan komprimeras. Utdata: `dist/`. |
| `npm run build:check` | Samma, men med utvecklingssidorna `/dev/foundation` och `/dev/speaker-review` (fixturer som gaten behöver). Utdata: `dist-check/`. En vanlig build har inga utvecklingsrouter. |
| `npm run dev` | Vites utvecklingsserver på port 3002; `/api` och `/health` (HTTP och WebSocket) proxas till `DEV_API_BASE` (standard `http://127.0.0.1:8000`) utan `changeOrigin`, så webbläsarens `Origin` når backendens kontroll oförändrad. |

- Vites utvecklings- och förhandsgranskningsservrar är aldrig produktionsservrar.
- Ingen `VITE_*`-variabel används och processens miljö exponeras inte. Den enda byggkonstanten är `__SPEAKER_REVIEW__`, satt från `SPEAKER_REVIEW_ENABLED` (`frontend/vite.config.mts`): en byggparameter, inte en körningsinställning.
- Utvecklingsservern fyller organisationsmarkören ur backenden som backenden gör i produktion (`frontend/lib/branding-marker.ts`).

## Routing, titlar och fokus

- `createBrowserRouter` (en data-router), utan loaders och utan serverrendering. De sidor som kräver inloggning lägger var sin `AuthGate`; ingen layoutroute håller grinden, så ett routebyte nollställer sidans tillstånd (`key={id}` på flödet). `/` och `/inloggad` ligger utanför grinden.
- **`RouteEffects`** äger vad som händer efter en navigering, en gång: routens titel sätts direkt; när sidan säger att den har sitt innehåll (`useRouteReady`) läses titeln upp i live-regionen, fokus flyttas till sidans rubrik (om inte sidan eller en dialog redan har det) och sidan scrollas (överst för en länk, till postens eget läge vid Bakåt). Sidan, inte routern, vet när innehållet finns. Ingen annan kod scrollar efter en navigering.
- **Lämna en sida med osparat arbete.** `useBlocker` (`components/flow/useLeaveQuestion.tsx`) frågar i sidans egen dialog vid varje avgång routern ser: länk, märket, Bakåt och Framåt. Att sidan själv skriver `?run=` eller `?recording=` i adressen är ingen avgång. Webbläsarens egen fråga (`beforeunload`) täcker det ingen navigering når: omladdning, att stänga fliken och Bakåt från första sidan i ett besök. Utloggning är en förfrågan, inte en navigering: frågan ställs före sessionen avslutas (`leaveFirst`).
- **En kod som inte går att hämta** (en flik som stått öppen över en ny version frågar efter filer som inte finns): sidan ersätts av "Sidan kunde inte visas." i appens ram (`RouteError`), och delar av en sida som laddas för sig (kalendern, den formaterade texten, granskningseditorn) behåller sitt innehåll och visar en statusrad. Åtgärden är alltid "Ladda om sidan", på personens eget val: inget laddas om av sig självt och inget som håller en inspelning eller en redigering monteras av (`frontend/lib/lazy-component.ts`).

## Konventioner

- **Gränssnittet byggs av Astryx-komponenter**, layout och sidram inräknade. Kör `npm run astryx -- build "<idé>"` och sedan `npm run astryx -- component <Namn>` för varje komponent; gissa aldrig en prop.
- **Inga Tailwind-klasser, ingen `<div>` för layout.** Stilning går via komponentens egna props, annars via en CSS-modul med Astryx-tokens (`var(--color-*)`, `var(--spacing-*)`, `var(--radius-*)`): inga hexvärden eller pixelavstånd förutom strukturella bredder. CSS-moduler (`*.module.css`, bredvid komponenten) är till för ytor som saknar motsvarighet i designsystemet (text med ordspann, nivåmätare, den fastlåsta spelaren, resultatets arbetsyta). Skriv inte om en sådan yta till komponenter för att slippa modulen.
- **Ett ansvar, en ägare.** Varje fråga har en fil som äger svaret, och det står överst i filen: `lib/recording-store.ts` äger inspelningarna på enheten, `lib/online-status.ts` om vi är uppkopplade, `lib/login-state.ts` om inloggningen håller, `lib/errors.ts` vad ett misslyckat anrop betyder för användaren, `lib/flow-session.ts` flödessidans inmatningssida. Lägg ny logik hos ägaren.
- **Sidans ram renderas av varje route.** `ModuleShell` (`kit/ModuleShell.tsx`) ger toppfält, hoppa-till-innehåll-länk och huvudregion, utan tillstånd: routen säger vad fältet visar, så en sida som inte får lämnas (en inspelning, en sändning) tar bort kontot och vägen tillbaka. En sida renderar aldrig egen `<main>` eller egen hoppa-länk.
- **Innehållets bredd** begränsas med `Layout contentWidth`, och handlingar justeras med `hAlign="start"` eller en `HStack` (en `VStack` sträcker sina barn över hela bredden).
- **Färgläget** (`light`, `dark`, `system`) ägs av `kit/ColorModeProvider.tsx`: valet ligger i `localStorage` under nyckeln `theme`, och `<html>` får `data-theme`. Ett litet, parser-blockerande skript från samma origin (`public/color-mode.js`) sätter attributet före första målningen, så ingen bildruta visas i fel läge och ingen inline-kod behövs. Lägg inget lägestillstånd någon annanstans.
- **Inga andra origins:** inga typsnitt, skript eller CDN.
- **Sidtitel och rubrik:** routen har en titel; en tillståndsvy sätter en närmare titel och flyttar fokus till sin rubrik när den visas, aldrig vid senare uppdateringar (`components/flow/usePhaseHeading.ts`, `useDocumentTitle` i `components/flow/recording-hooks.ts`).
- **Dialoger och menyer** är Astryx egna (native `<dialog>`). Tillstånd som ska överleva att en dialog stängs ligger ovanför dialogen, aldrig inuti den. Medan inloggningen har gått ut ligger sidan kvar, dold och låst, och en dialog ber om ny inloggning ([beslut 0004](decisions/0004-native-dialogs-and-the-session-cover.md)).

## Var tillståndet bor

| Tillstånd | Ägare | Anmärkning |
|---|---|---|
| Inloggningens giltighet, och vilken användare sidan öppnades för | `lib/login-state.ts` (`loginState`, `expectedUser`), matas av `AuthGate` | Sidan ligger kvar när inloggningen slutar eller en annan person loggat in. [Inloggning och session](auth-and-session.md#när-inloggningen-har-gått-ut) |
| Sessionsstatus från backend | `authStatus()` i `lib/api.ts`, hållen vid liv av `lib/session-keepalive.ts` | `refresh_in` och `session_ends_in` styr nästa fråga och varningen. |
| Färgläge | `kit/ColorModeProvider.tsx` (`localStorage`, `data-theme`) | |
| Organisationens märke | Läses ur sidan före första renderingen (`lib/read-branding.ts`), ligger i `BrandingProvider` (`components/Brand.tsx`) | Accentfärgen är inget tillstånd: den kommer som en stilmall, `/api/branding/theme.css`. [Byt organisation](branding.md) |
| Flödessidans inmatning (läge, uppgifter, talarval, fas) | `lib/flow-session.ts` (`FlowSession`), bunden till React av `components/flow/useFlowSession.ts` | Faserna är `setup`, `starting`, `recording`, `paused`, `interrupted`, `ready`. Fasen läses ur inspelaren, kopieras aldrig. |
| Inspelningen (fångst) | `lib/recording-session.ts`, ägd av `FlowSession` | [Inspelaren](recording.md) |
| Inspelningar på enheten | `lib/recording-store.ts` (IndexedDB) | Överlever omladdning och utgången session. |
| Det man skrivit men inte skickat | `lib/drafts.ts` (`sessionStorage`, per person) | En annan person som loggar in här rensar de andras. Skickat eller sparat tas bort. |
| Körningens tillstånd | `run` i `routes/FlowPage.tsx` | Se nedan. |
| Uppföljning av en körning | `lib/follow-run.ts` | Frågar bara efter det som är gjort för polling, och sällan medan sidan är dold. |
| Om vi är uppkopplade | `lib/online-status.ts` | Webbläsarens händelser plus våra egna anrop. |
| Mikrofonval | `lib/microphone.ts` | Kommer ihåg per webbläsare. |

Kan det göras utan React hör det hemma i `lib/` med ett test bredvid.

## Sidornas tillstånd

Varje tillstånd är en skärm som gaten besöker; namnen finns i `frontend/tests/e2e/screens.ts`.

| Sida | Tillstånd |
|---|---|
| Inloggning (`/`) | laddar, Logga in med Eneo, fel, modulen nås inte. Ett `auth_error` i adressen ger ett meddelande och tas bort ur adressen. |
| Flödeslistan (`/flows`) | laddar (skelett), problem med försök igen, tom, lista grupperad per space, avkortad vid sidtaket, osända inspelningar överst. |
| Ett flöde (`/flows/:id`) | flödet laddar (skelett), flödet kan inte användas, och därefter körningens `run.kind`: `idle` (inmatningen, med faserna ovan), `submitting` (filerna laddas upp och körningen startas), `opening` (en körning öppnas efter omladdning eller från `?run=`), `unread` (körningen kunde inte läsas, med försök igen), `running`, `awaiting_review`, `done` (resultat, eller misslyckad med försök igen från det misslyckade steget). |
| Tvärgående | inloggningen går ut snart (varningsdialogen), inloggningen har gått ut (täckskiktet och dialogen), offline (en rad som säger vad som väntar), signerad in igen (`/inloggad`). |

Adressparametrar på flödessidan: `?run=<id>` öppnar en körning, `?recording=<id>` en osänd inspelning.

## Designsystemet

Astryx (`@astryxdesign/core`) ger komponenter, layoutprimitiver, tokens och en CLI. Kärnan, CLI:t och `@stylexjs/stylex` (en peer-beroende: inget skrivs i StyleX) är fastlåsta till exakta versioner i `frontend/package.json`. CLI:t är källan till sanning om den installerade versionen; den hostade Astryx-MCP:n dokumenterar den senaste utgåvan.

| Fakta | Följd |
|---|---|
| `AppShell` renderar hoppa-till-innehåll-länken och en `role="main"`-region. | Ingen `<main>` eller hoppa-länk på en sida. |
| `Dialog` är en native `<dialog>` på plats, utan portal; `purpose="required"` stänger av Escape och bakgrundsstängning. | [Beslut 0004](decisions/0004-native-dialogs-and-the-session-cover.md). |
| Ett tema namnger typsnitt men laddar dem aldrig. | Inga tredjepartsförfrågningar för typsnitt. |
| Full återgivning: Chrome och Edge 125+, Safari 26+, Firefox 147+. Äldre öppnar och stänger lagrade ytor (menyer, väljare) men placerar dem inte vid utlösaren. | Kontrolleras för hand på en riktig enhet inför en release. |

CLI-kommandon (från `frontend/`, alltid via `npm run astryx --`):

| Kommando | Används för |
|---|---|
| `build "<idé>"` | Närmaste sidmall, block och komponenter. |
| `component <Namn>` | Props och exempel. `--dense` ger en kortare form. |
| `docs <ämne>` | Referensdokument: `layout`, `tokens`, `color`, `typography`, `motion`. Läs `docs layout` före en ny sida. |
| `theme targets <filter>` | Vilka komponentdelar ett tema kan åsidosätta. |
| `doctor` | Kontrollerar uppsättningen (körs i CI). |

Regler: komponenter först; inga hexfärger eller pixelavstånd (använd tokens); överstyr aldrig `--color-*` i `:root`; skriv inte StyleX (`stylex.create`, `xstyle`) och kör inte `astryx swizzle`; tät data är rader (`Table`, `List`), aldrig kort runt listobjekt; status är `StatusDot` eller `Token`, `Badge` är bara antal. Astryx egna ord (till exempel "Hoppa till innehåll") kommer ur `@astryxdesign/core/locales/sv-SE.json`.

### Eneo-temat

| Sökväg | Roll |
|---|---|
| `frontend/kit/theme/eneo.theme.ts` | Temakällan: accent, typografi, tokens, komponentåsidosättningar och anpassningar. **Det enda stället** en brist i designsystemet rättas. |
| `frontend/kit/theme/built/eneo.{css,js,d.ts}` | Genereras av `npm run theme:build`, är incheckade och redigeras aldrig för hand. De ligger i en egen mapp: bredvid källan skulle bundlern hitta `.ts`-filen och tyst bygga temat i webbläsaren. |
| `frontend/styles/layers.css` | Skiktordningen `reset, astryx-base, astryx-theme`, importerad först i `main.tsx`. |

- **Accent:** Sundsvalls blå `#004595` (mörkt läge `#52B1FF`), satt som explicita tokens: `color.accent` ger bara en tonpalett ur ett frö, inte själva fröet. En driftsättning byter accenten med `ORGANIZATION_ACCENT`; backend serverar den som en stilmall som ersätter temats värde ([Byt organisation](branding.md)).
- **Typsnitt:** systemtypsnitt i 16 px med skala 1,2, inga webbtypsnitt.
- **Pekmål:** under `pointer: coarse` höjs kontroller, menyrader och val till 44 px.
- **Fokusring** på fält och väljare, en läsbar etikett på felfärgen i mörkt läge, och ordbrytning av ord utan brytpunkt (en e-postadress som namn) så att inget når utanför en 320 px-skärm.
- Domänfärgerna (inspelningsröd, de sex talarfärgerna) är CSS-variabler i `styles/globals.css`.

### Rätta en brist i designsystemet

Rätta den en gång i temat, aldrig vid ett enskilt anrop:

1. Läs felet i gaten ([Tester](quality-gates.md#läsa-ett-fel)): komponent och tillstånd.
2. Hitta komponentens tema-mål med `npm run astryx -- theme targets <filter>`.
3. Lägg rättelsen i `eneo.theme.ts`: en token under `tokens`, en åsidosättning under `components` (till exempel `'text-input': {base: {':focus-within': focusRing}}`) eller en regel under `adaptations.rules` (till exempel `when: {pointer: 'coarse'}`).
4. `npm run theme:build`, och checka in både källan och `kit/theme/built/`; CI misslyckas om de skiljer sig åt.
5. Kör läget i gaten, sedan `npm run test:prod`.

Kräver en rättelse en utkopierad eller förgrenad Astryx-komponent för att klara gaten är det ett stoppvillkor: rapportera det.

### Tillgänglighetsnivån

WCAG 2.2 AA, med husets krav ovanpå: pekmål 24 px med mus och 44 px med finger, en synlig fokusindikator med minst 3:1 förändring som inte skyms, inga oändliga animationer med reducerad rörelse, och allt användbart med tvingade färger. Beviset är `npm run test:a11y` ([Tester](quality-gates.md)).

### Uppgradera Astryx

Astryx uppgraderas aldrig i en funktionsändring. En uppgradering är en egen pull request:

1. Bumpa `@astryxdesign/core` och `@astryxdesign/cli` till samma exakta version (och `@stylexjs/stylex` till den version Astryx kräver).
2. `npm run astryx -- upgrade --from <gammal version>` är en torrkörning av kodmodifieringarna; `--apply` skriver dem. Granska diffen.
3. `npm run astryx -- doctor`, `npm run theme:build` och granska `kit/theme/built/`.
4. Hela gaten och `npm run test:prod`. Återställning är att backa pull requesten.

`frontend/AGENTS.md` är ett block som Astryx-CLI:t genererar; rör det inte för hand. Reglerna som gäller i just det här repot står i rot-`AGENTS.md` och går före det genererade blocket där de skiljer sig.

## Lägga till en skärm

1. **Hitta delarna:** `npm run astryx -- build "<vad skärmen är>"`, `template <namn> --skeleton` för ramen, `component <Namn>` för varje komponent och `docs layout` för sidramen.
2. **Route:** lägg sidan i `frontend/routes/` och i `frontend/routes.tsx` med en titel, bakom `AuthGate` om den kräver inloggning, och rendera `ModuleShell`. Anropa `useRouteReady` när sidan har sitt innehåll.
3. **Logik i `lib/`** med ett test bredvid (`lib/<namn>.test.ts`); komponenttester ligger också där.
4. **Specialyta?** Bara om designsystemet saknar motsvarighet: en CSS-modul bredvid komponenten, bara tokens.
5. **Läge i gaten:** lägg lägen för skärmen i `frontend/tests/e2e/screens.ts`; ett nytt överlägg läggs i `leaks.spec.ts`. [Tester](quality-gates.md)
6. **Kontrollera:** `npm run lint`, `npm test`, läget i `phone-320-light` och `zoom-200`, sedan `npm run test:a11y`, `npm run test:prod` och `npm run build`.
