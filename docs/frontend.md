# Frontend

Syfte: Beskriva frontendens lager och konventioner, var tillståndet bor, vilka tillstånd en sida har och hur man lägger till en skärm.

Läs detta när: Du ska bygga eller ändra en skärm, vet inte var en bit logik hör hemma, eller ska förstå hur sidorna hänger ihop.

Hör ihop med: [Arkitektur](architecture.md#frontendens-lager), [Designsystem](design-system.md), [Kvalitetsgrindar](quality-gates.md), [Inspelaren](recording.md), [Inloggning och session](auth-and-session.md), [Ordlista](glossary.md)

## Stack

Next.js 16 (App Router, byggd med webpack: `npm run build`) är frontend-servern i dag; ett byte till statiska filer är planerat men inte påbörjat. React, TypeScript, Astryx för gränssnittet och next-themes för färgläget. Versionerna står i `frontend/package.json`; Astryx är fastlåst till en exakt version. All text som användaren läser är svenska.

## Lager

| Katalog | Innehåll | Får importera |
|---|---|---|
| `frontend/app/` | Routes och sidor: `/` (inloggning), `/flows` (flödeslistan), `/flows/[id]` (ett flöde: inmatning, körning, resultat), `/inloggad` (sidan som förnyelsefönstret visar), utvecklingssidor under `app/dev/`. Rotlayouten (`layout.tsx`) har bara providers. | allt nedan |
| `frontend/components/` | Skärmar och ytor. `components/flow/` är flödessidans delar. | `kit/`, `lib/`, Astryx |
| `frontend/kit/` | Tema, providers och skal: `ModuleProviders`, `ModuleShell`, `theme/`. Ska kunna lyftas ut: importerar inget från `app/`, `components/` eller `lib/`. | Astryx |
| `frontend/lib/` | Logik utan gränssnitt, ett ansvar per fil, och testerna bredvid (enhets- och komponenttester ligger tillsammans här). Importerar ingen UI-kod. | inget från `app/`, `components/` eller `kit/` |
| `frontend/public/` | Statiska filer: Sundsvalls logotyp och live-ljudets AudioWorklet. | |
| `frontend/tests/` | Grinden (`e2e/`), produktionssmoke (`prod/`), fixturer. Se [Kvalitetsgrindar](quality-gates.md). | |

Importriktningen visas i [diagrammet](architecture.md#frontendens-lager).

## Konventioner

- **Gränssnittet byggs av Astryx-komponenter**, layout och sidram inräknade. Kör `npm run astryx -- build "<idé>"` och sedan `npm run astryx -- component <Namn>` för varje komponent; gissa aldrig en prop. Se [Designsystem](design-system.md).
- **Inga Tailwind-klasser, ingen `<div>` för layout** i ny eller portad kod. Stilning går via komponentens egna props, annars via en CSS-modul med Astryx-tokens.
- **CSS-moduler** får användas på de få specialytorna som saknar motsvarighet i designsystemet (text med ordspann, nivåmätare, den fastlåsta spelaren, resultatets arbetsyta). De ligger bredvid sin komponent som `*.module.css` och använder bara Astryx-tokens (`var(--color-*)`, `var(--spacing-*)`, `var(--radius-*)`) och semantisk HTML, inga hexvärden eller pixelavstånd förutom strukturella bredder. Skriv inte om en sådan yta till komponenter bara för att slippa modulen.
- **Ett ansvar, en ägare.** Varje fråga har en fil som äger svaret, och det står överst i filen: `lib/recording-store.ts` äger inspelningarna på enheten, `lib/online-status.ts` om vi är uppkopplade, `lib/login-state.ts` om inloggningen håller, `lib/errors.ts` vad ett misslyckat anrop betyder för användaren, `lib/flow-session.ts` flödessidans inmatningssida. Lägg ny logik hos ägaren, inte vid sidan om den.
- **Sidans ram renderas av varje route**, inte av rotlayouten. `ModuleShell` (`kit/ModuleShell.tsx`) ger toppfält, hoppa-till-innehåll-länk och huvudregion. Den saknar tillstånd och bestämmer inget: routen säger vad fältet visar, så en sida som inte får lämnas (en inspelning, en sändning) tar bort kontot och vägen tillbaka. En sida renderar aldrig egen `<main>` eller egen hoppa-länk.
- **Sidans innehåll** begränsas med `Layout contentWidth` så att texter och formulär håller en läsbar bredd på ultrabreda skärmar, och handlingar justeras med `hAlign="start"` eller en `HStack` (en `VStack` sträcker sina barn över hela bredden).
- **Färgläget ägs av next-themes** (klassen på `<html>`); lägg inget lägestillstånd i `ModuleProviders`. Se [beslutet](decisions/0003-next-themes-owns-the-colour-mode.md).
- **Inga andra origins**: inga typsnitt, skript eller CDN. CSP:n tillåter dem inte.
- **Svensk text**, 44 px pekytor med finger, synlig fokusindikator, WCAG 2.2 AA. Beviset är grinden.
- **Sidtitel och rubrik**: serversidor sätter `metadata`; en tillståndsvy sätter titeln och flyttar fokus till sin rubrik när den visas, aldrig vid senare uppdateringar (`components/flow/usePhaseHeading.ts`, `useDocumentTitle` i `components/flow/recording-hooks.ts`).
- **Dialoger och menyer** är Astryx egna (native `<dialog>`). Tillstånd som ska överleva att en dialog stängs ligger ovanför dialogen, aldrig inuti den. Se [beslutet om täckskiktet](decisions/0004-native-dialogs-and-the-session-cover.md).

## Var tillståndet bor

| Tillstånd | Ägare | Anmärkning |
|---|---|---|
| Inloggningens giltighet | `lib/login-state.ts` (`loginState`), matas av `AuthGate` | Sidan ligger kvar när inloggningen slutar. Se [Inloggning och session](auth-and-session.md#när-inloggningen-har-gått-ut). |
| Sessionsstatus från backend | `authStatus()` i `lib/api.ts`, hållen vid liv av `lib/session-keepalive.ts` | `refresh_in` och `session_ends_in` styr nästa fråga och varningen. |
| Färgläge | next-themes (klass på `<html>`, `localStorage`) | `kit/ModuleProviders.tsx` läser det, skriver aldrig. |
| Organisationens märke | Läses i `app/layout.tsx` per request, ligger i `BrandingProvider` (`components/Brand.tsx`) | |
| Flödessidans inmatningssida (läge, uppgifter, talarval, fas) | `lib/flow-session.ts` (klassen `FlowSession`), bunden till React av `components/flow/useFlowSession.ts` | Faserna är `setup`, `starting`, `recording`, `paused`, `interrupted`, `ready`. Fasen läses ur inspelaren, kopieras aldrig. |
| Inspelningen (fångst) | `lib/recording-session.ts`, ägd av `FlowSession` | Se [Inspelaren](recording.md). |
| Inspelningar på enheten | `lib/recording-store.ts` (IndexedDB) | Överlever omladdning och utgången session. |
| Det man skrivit men inte skickat | `lib/drafts.ts` (`sessionStorage`, per person) | En annan person som loggar in här rensar de andras. Skickat eller sparat tas bort. |
| Körningens tillstånd | `run` i `app/flows/[id]/page.tsx` | Se nedan. |
| Uppföljning av en körning | `lib/follow-run.ts` | Frågar bara efter det som är gjort för polling; frågar sällan medan sidan är dold. |
| Om vi är uppkopplade | `lib/online-status.ts` | Webbläsarens händelser plus våra egna anrop. |
| Lämna sidan | `lib/leave-guard.ts`, `components/flow/useLeaveQuestion.tsx` | Webbläsarens bakåtknapp förlorar aldrig en inspelning. |
| Mikrofonval | `lib/microphone.ts` | Kommer ihåg per webbläsare. |

Frågar du dig "var hör det här hemma": kan det göras utan React hör det hemma i `lib/` med ett test bredvid.

## Sidornas tillstånd

Varje tillstånd är en skärm som grinden besöker. Namnen nedan är namn i `frontend/tests/e2e/screens.ts`.

| Sida | Tillstånd |
|---|---|
| Inloggning (`/`) | laddar (`signin-loading`), Eneo SSO (`signin-sso`), åtkomstkod (`signin-access-code`), fel (`signin-error`), modulen nås inte (`signin-unreachable`). Ett `auth_error` i adressen ger ett meddelande och tas bort ur adressen. |
| Flödeslistan (`/flows`) | laddar (skelett), problem med försök igen, tom, lista grupperad per space, avkortad vid sidtaket, osända inspelningar överst. |
| Ett flöde (`/flows/[id]`) | flödet laddar (skelett), flödet kan inte användas (`FlowUnavailable`), och därefter körningens `run.kind`: |
| | `idle`: inmatningen, med faserna `setup`, `starting`, `recording`, `paused`, `interrupted` och `ready`. |
| | `submitting`: filerna laddas upp och körningen startas. |
| | `opening`: en körning öppnas (efter omladdning eller från adressen `?run=`). |
| | `unread`: körningen kunde inte läsas, med försök igen. |
| | `running`: körningen pågår och följs. |
| | `awaiting_review`: körningen väntar på granskning. |
| | `done`: resultat (lyckad) eller misslyckad (`RunFailure`, med försök igen från det misslyckade steget). |
| Tvärgående | inloggningen går ut snart (varningsdialogen), inloggningen har gått ut (täckskiktet och dialogen), offline (rad som säger vad som väntar), signerad in igen (`/inloggad`). |

Adressparametrar på flödessidan: `?run=<id>` öppnar en körning, `?recording=<id>` öppnar en osänd inspelning.

## Lägga till en skärm

1. **Hitta delarna.** Kör `npm run astryx -- build "<vad skärmen är>"`, `npm run astryx -- template <namn> --skeleton` för ramen, `npm run astryx -- component <Namn>` för varje komponent och `npm run astryx -- docs layout` för sidramen. Gör det från `frontend/`.
2. **Route.** Lägg sidan under `frontend/app/`, bakom `AuthGate` om den kräver inloggning, och rendera `ModuleShell` i sidan. Sätt `metadata` (serversida) eller en dokumenttitel.
3. **Logik i `lib/`.** Allt som kan testas utan React flyttas dit, med ett test bredvid (`lib/<namn>.test.ts`). Komponenttester ligger också där.
4. **Specialyta?** Bara om designsystemet saknar motsvarighet: en CSS-modul bredvid komponenten, bara tokens.
5. **Läge i grinden.** Lägg lägen för skärmen i `frontend/tests/e2e/screens.ts`; ett nytt överlägg läggs i `leaks.spec.ts`. Se [Kvalitetsgrindar](quality-gates.md#lägga-till-en-skärm-eller-ett-överlägg).
6. **Kontrollera.** `npm run lint`, `npm test`, läget i `phone-320-light` och `zoom-200`, sedan `npm run test:a11y`, `npm run test:prod` och `npm run build`.
7. **Svensk text** i allt användaren läser.

## Migration (temporary, removed by bead .24)

Gränssnittet porteras från shadcn/Radix/Tailwind till Astryx, en ytgrupp åt gången. Under tiden:

- Filer som ännu använder det gamla systemet står i `frontend/tests/legacy-ui-files.json`. Ta bort en fil ur listan när den är portad; lägg aldrig till en.
- `frontend/components/ui/` (kopierade shadcn-filer), `frontend/components.json`, `frontend/tailwind.config.ts`, `frontend/postcss.config.mjs`, `frontend/lib/utils.ts` och Tailwind-delarna av `frontend/app/globals.css` är det gamla systemet och får inte användas för nytt arbete. De tas bort i portningens sista fas.
- Använd inte shadcn-färdigheten eller shadcn-MCP för nytt arbete.
- Vilka filer som ännu ligger på det gamla systemet ser du i listan ovan; den krymper för varje ytgrupp som portas.
- Planen och dess status: `docs/plans/2026-10-01-astryx-port-plan.md`.
