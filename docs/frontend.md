# Frontend

Gränssnittet är en React-app med Vite, react-router och designsystemet Astryx. Den byggs till statiska filer som backenden serverar ([Backend](backend.md#statiska-filer-och-säkerhetsheaders)). All text användaren läser är svenska.

## Lager

| Sökväg | Innehåll |
|---|---|
| `frontend/routes.tsx`, `frontend/routes/` | Routetabellen (`/` inloggning, `/flows` flödeslistan, `/flows/:id` ett flöde, `/inloggad` sidan som förnyelsefönstret visar, varje annan adress "Sidan finns inte.") och sidorna. Varje sidas kod hämtas när routen först besöks. På `/flows/:id` hämtas en körnings resultat, granskning och felvy (`components/flow/run-views.tsx`) först när en körning öppnas, medan körningen läses. `routes/dev/` är utvecklingssidor. |
| `frontend/components/` | Skärmar och ytor. `components/flow/` är flödessidans delar. |
| `frontend/kit/` | Tema, providers och skal (`ModuleShell`, `ColorModeProvider`). Importerar inget från `routes/`, `components/` eller `lib/`. |
| `frontend/lib/` | Logik utan gränssnitt, ett ansvar per fil, med testerna bredvid. Importerar ingen UI-kod. |
| `frontend/styles/`, `frontend/public/` | Skiktordningen och modulens egna stilar; filer som kopieras oförändrade (live-ljudets AudioWorklet, skriptet för första målningen och ikonerna för fliken och hemskärmen). |

`routes/` och `components/` får importera `kit/`, `lib/` och Astryx; `kit/` bara Astryx; `lib/` ingen UI.

## Byggen

| Kommando (från `frontend/`) | Resultat |
|---|---|
| `npm run build` | Typkontroll, `vite build` och `scripts/finish-build.mjs` (kontrollerar sidans organisationsmarkör och skriver `.br` och `.gz` bredvid varje fil som kan komprimeras). Utdata: `dist/`. |
| `npm run build:check` | Samma, men med utvecklingssidorna `/dev/foundation` och `/dev/speaker-review`, som gaten behöver. Utdata: `dist-check/`. En vanlig build har inga utvecklingsrouter. |
| `npm run dev` | Vites utvecklingsserver på port 3002, som proxar `/api` och `/health` till backend ([Lokal utveckling](development.md)). Aldrig en produktionsserver. |

Den enda byggkonstanten är `__SPEAKER_REVIEW__`, satt från `SPEAKER_REVIEW_ENABLED`: en byggparameter, inte en körningsinställning.

## Routing, titlar och fokus

- Routern är en data-router utan loaders och utan serverrendering. Varje sida som kräver inloggning lägger en egen `AuthGate`, så ett routebyte nollställer sidans tillstånd. Den som inte är inloggad skickas till inloggningen och därifrån tillbaka till adressen den öppnade, med `?run=` ([Inloggning och session](auth-and-session.md#eneo-sso)).
- Efter en navigering sätts routens titel direkt, och när sidan säger att den har sitt innehåll (`useRouteReady`) läses titeln upp, fokus flyttas till sidans rubrik och sidan scrollas. Ingen annan kod scrollar efter en navigering (`routes/RouteEffects.tsx`).
- En sida med osparat arbete frågar i sin egen dialog innan den lämnas: länk, märket, Bakåt och Framåt. Webbläsarens egen fråga täcker omladdning och att stänga fliken.
- En kod som inte går att hämta (en flik som stått öppen över en ny version) ersätts av "Sidan kunde inte visas." med åtgärden "Ladda om sidan", på personens eget val: inget laddas om av sig självt och inget som håller en inspelning eller en redigering monteras av.
- En adress som inte är någon av appens sidor visar "Sidan finns inte." med vägen till startsidan; adressen står kvar som den skrevs. Den och "Sidan kunde inte visas." (`routes/Root.tsx`) har egna titlar, och efter en navigering läses de upp och deras rubrik får fokus som på andra sidor.

## Konventioner

- **Gränssnittet byggs av Astryx-komponenter**, layout och sidram inräknade. Kör `npm run astryx -- build "<idé>"` och sedan `npm run astryx -- component <Namn>` för varje komponent; gissa aldrig en prop.
- **Inga Tailwind-klasser, ingen `<div>` för layout.** Stilning går via komponentens egna props, annars via en CSS-modul med Astryx-tokens (`var(--color-*)`, `var(--spacing-*)`, `var(--radius-*)`): inga hexvärden eller pixelavstånd förutom strukturella bredder. CSS-moduler är till för ytor som saknar motsvarighet i designsystemet (text med ordspann, nivåmätare, den fastlåsta spelaren, resultatets arbetsyta). Skriv inte om en sådan yta till komponenter för att slippa modulen.
- **Sidans ram renderas av varje route.** `ModuleShell` ger toppfält, hoppa-till-innehåll-länk och huvudregion, utan tillstånd. En sida renderar aldrig egen `<main>` eller egen hoppa-länk.
- **Innehållets bredd** begränsas med `Layout contentWidth`, och handlingar justeras med `hAlign="start"` eller en `HStack` (en `VStack` sträcker sina barn över hela bredden).
- **Färgläget** (`light`, `dark`, `system`) ägs av `kit/ColorModeProvider.tsx`: valet ligger i `localStorage` under nyckeln `theme`, och `<html>` får `data-theme`. Ett litet skript från samma origin (`public/color-mode.js`) sätter attributet före första målningen. Lägg inget lägestillstånd någon annanstans.
- **Inga andra origins:** inga typsnitt, skript eller CDN.
- **Sidtitel och rubrik:** routen har en titel; en tillståndsvy sätter en närmare titel och flyttar fokus till sin rubrik när den visas, aldrig vid senare uppdateringar.
- **Dialoger och menyer** är Astryx egna (native `<dialog>`). Tillstånd som ska överleva att en dialog stängs ligger ovanför dialogen, aldrig inuti den ([beslut 0004](decisions/0004-native-dialogs-and-the-session-cover.md)).

## Layout och handlingar

- **Ett beslut** (granskningens Avvisa och godkännande, en dialogs Avbryt och Spara) är `components/ActionRow.tsx`: en rad i slutet av ytan med huvudåtgärden sist, och upp till 640 px en stapel över hela bredden med huvudåtgärden överst, som `AlertDialog`. Barnen skrivs i radens ordning.
- **Ett fälts egna knappar** är inget beslut: små, i textens rubrikrad ovanför fältet (granskningens Redigera, Avbryt och Spara ändring, den sista bara när något har ändrats).
- **En lång text under granskning** har en enda scroll: rubrikraden stannar överst i fönstret och beslutet nederst, fältet växer med texten och Redigera öppnar där man läser. Ett lågt fönster (telefon på sidan, 200 % zoom) håller båda i sidan.
- **Läsbredd:** granskad text och resultatets dokument högst 75 tecken per rad; textgranskningen är en läskolumn från 1024 px.
- **Resultatet:** huvudåtgärden först (nedladdningen, eller Kopiera för en text utan fil), de två andra bredvid när raden har plats och annars i menyn **Fler alternativ** (`components/flow/ResultDocument.tsx`). En PDF öppnas i en dialog bara med mus (från 640 px, från filens namn från 1024 px); på en pekskärm och i ett smalare fönster i en egen flik (`components/flow/ResultFiles.tsx`).
- **Transkriberingens talare** på en färdig körning: en egen rad ovanför talarfiltret, med **Talare** först (också filtrets namn för en skärmläsare) och **Namnge talare** sist; en repliks **Ändra talare** har **Byt namn på** dess talare efter valet och vad det gäller. Båda öppnar granskningens namndialog (`components/SpeakerNamingDialog.tsx`), och fokus går tillbaka dit den öppnades.
- **Inspelningar som inte har skickats** (`components/UnsentRecordings.tsx`): upp till 640 px en stapel över hela kortet, bredare en rad med **Ta bort** sist; frågan om att ta bort är ett beslut.
- **Rörelse** tar `--duration-fast` och `--ease-standard`, bara opacitet: en vy av flödet som ersätter en annan tonar in (`components/flow/FlowFrame.module.css`), liksom en utfällnings innehåll (`styles/globals.css`). Med reducerad rörelse tonar inget.

## Var tillståndet bor

Varje fråga har en fil som äger svaret, och det står överst i filen. Lägg ny logik hos ägaren; kan det göras utan React hör det hemma i `lib/` med ett test bredvid.

| Tillstånd | Ägare |
|---|---|
| Inloggningens giltighet, och vilken användare sidan öppnades för | `lib/login-state.ts`, matad av `AuthGate` ([Inloggning och session](auth-and-session.md#när-inloggningen-har-gått-ut)) |
| Sessionsstatus från backend | `authStatus()` i `lib/api.ts`, hållen vid liv av `lib/session-keepalive.ts` |
| Färgläge | `kit/ColorModeProvider.tsx` |
| Organisationens märke | läses ur sidan före första renderingen (`lib/read-branding.ts`); accenten kommer som en stilmall ([Byt organisation](branding.md)) |
| Vilket bygge som körs | läses ur backenden (`buildIdentity()` i `lib/api.ts`) när Version i flödeslistan först öppnas; hur det visas och kopieras: `lib/build-identity.ts` |
| Flödessidans inmatning (läge, uppgifter, talarval, fas) | `lib/flow-session.ts`, bunden till React av `components/flow/useFlowSession.ts`; fasen läses ur inspelaren, kopieras aldrig |
| Inspelningen (fångst) | `lib/recording-session.ts`, ägd av `FlowSession` ([Inspelaren](recording.md)) |
| Inspelningar på enheten | `lib/recording-store.ts` (IndexedDB) |
| Det man skrivit men inte skickat | `lib/drafts.ts` (`sessionStorage`, per person) |
| Talarnas namn: ett namngivningsstegs, med de namn som ges efter körningen ovanpå | Eneos rättningsset; regeln är `effectiveSpeakerNames` i `lib/transcript-corrections.ts` |
| Var uppspelningen av en körning stannade | `lib/playback-position.ts` (`localStorage`, de 50 senast lyssnade körningarna) |
| Körningens tillstånd | `run` i `routes/FlowPage.tsx`; uppföljningen i `lib/follow-run.ts` |
| Om vi är uppkopplade, och vad sidan säger när vi inte är det: "Ingen anslutning." när enheten saknar nät, annars "Tal till text svarar inte just nu." | `lib/online-status.ts` |
| Vad ett misslyckat anrop betyder för användaren | `lib/errors.ts` |
| Mikrofonval | `lib/microphone.ts` |

Skärmarnas lägen finns i `frontend/tests/e2e/screens.ts`; flödessidans adressparametrar är `?run=<id>` (öppnar en körning), `?recording=<id>` (en osänd inspelning skickas) och `?continue=<id>` (en avbruten inspelning spelas in vidare).

## Designsystemet

Astryx (`@astryxdesign/core`) ger komponenter, layoutprimitiver, tokens och en CLI; `npm run astryx -- docs <ämne>` är referensen. Kärnan, CLI:t och `@stylexjs/stylex` (en peer-beroende: inget skrivs i StyleX) är fastlåsta till exakta versioner i `frontend/package.json`. Tre fakta som slår:

- `AppShell` renderar hoppa-till-innehåll-länken och en `role="main"`-region, så en sida har ingen egen `<main>` eller hoppa-länk.
- `Dialog` är en native `<dialog>` på plats, utan portal; `purpose="required"` stänger av Escape och bakgrundsstängning.
- Full återgivning: Chrome och Edge 125+, Safari 26+, Firefox 147+. Äldre öppnar och stänger lagrade ytor (menyer, väljare) men placerar dem inte vid utlösaren; det kontrolleras för hand på en riktig enhet inför en release.

Dessutom: överstyr aldrig `--color-*` i `:root`; skriv inte StyleX (`stylex.create`, `xstyle`) och kör inte `astryx swizzle`; tät data är rader (`Table`, `List`), aldrig kort runt listobjekt; status är `StatusDot` eller `Token`, `Badge` är bara antal.

### Eneo-temat

`frontend/kit/theme/eneo.theme.ts` är temakällan (accent `#004595`, mörkt läge `#52B1FF`, systemtypsnitt, tokens, komponentåsidosättningar och anpassningar för pekmål) och **det enda stället** en brist i designsystemet rättas. `frontend/kit/theme/built/` genereras av `npm run theme:build`, är incheckad och redigeras aldrig för hand; den ligger i en egen mapp, för bredvid källan skulle bundlern hitta `.ts`-filen och tyst bygga temat i webbläsaren. En driftsättning byter accenten med `ORGANIZATION_ACCENT` ([Byt organisation](branding.md)). Domänfärgerna (inspelningsröd, de sex talarfärgerna) är CSS-variabler i `styles/globals.css`.

### Rätta en brist i designsystemet

Rätta den en gång i temat, aldrig vid ett enskilt anrop:

1. Läs felet i gaten ([Tester](quality-gates.md#läsa-ett-fel)) och hitta komponentens tema-mål med `npm run astryx -- theme targets <filter>`.
2. Lägg rättelsen i `eneo.theme.ts`: en token under `tokens`, en åsidosättning under `components` eller en regel under `adaptations.rules`.
3. `npm run theme:build`, och checka in både källan och `kit/theme/built/`; CI misslyckas om de skiljer sig åt.
4. Kör läget i gaten, sedan `npm run test:prod`.

Kräver en rättelse en utkopierad eller förgrenad Astryx-komponent för att klara gaten är det ett stoppvillkor: rapportera det.

### Uppgradera Astryx

Astryx uppgraderas aldrig i en funktionsändring; en uppgradering är en egen pull request:

1. Bumpa `@astryxdesign/core` och `@astryxdesign/cli` till samma exakta version (och `@stylexjs/stylex` till den version Astryx kräver).
2. `npm run astryx -- upgrade --from <gammal version>` är en torrkörning av kodmodifieringarna; `--apply` skriver dem. Granska diffen.
3. `npm run astryx -- doctor`, `npm run theme:build` och granska `kit/theme/built/`.
4. Hela gaten och `npm run test:prod`. Återställning är att backa pull requesten.

`frontend/AGENTS.md` genereras av Astryx-CLI:t; rör det inte för hand. Reglerna som gäller i just det här repot står i rot-`AGENTS.md` och går före det genererade blocket där de skiljer sig.

## Lägga till en skärm

1. **Hitta delarna:** `npm run astryx -- build "<vad skärmen är>"`, `template <namn> --skeleton` för ramen, `component <Namn>` för varje komponent och `docs layout` för sidramen.
2. **Route:** lägg sidan i `frontend/routes/` och i `frontend/routes.tsx`, bakom `AuthGate` om den kräver inloggning, och rendera `ModuleShell`. Routens titel är `documentTitle("<sidans namn>")`, sidans namn följt av `PRODUCT_NAME`; båda ägs av `frontend/lib/product.ts`, som är gränssnittets ägare av produktnamnet i titlar, rubriker och landmärken. Anropa `useRouteReady` när sidan har sitt innehåll.
3. **Logik i `lib/`** med ett test bredvid (`lib/<namn>.test.ts`); komponenttester ligger också där.
4. **Specialyta?** Bara om designsystemet saknar motsvarighet: en CSS-modul bredvid komponenten, bara tokens.
5. **Läge i gaten:** lägg lägen för skärmen i `frontend/tests/e2e/screens.ts`; ett nytt överlägg läggs i `leaks.spec.ts`. [Tester](quality-gates.md)
6. **Kontrollera:** `npm run lint`, `npm test`, läget i `phone-320-light` och `zoom-200`, sedan `npm run test:a11y`, `npm run test:prod` och `npm run build`.
