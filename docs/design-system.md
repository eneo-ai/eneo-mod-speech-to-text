# Designsystem

Syfte: Beskriva Astryx och Eneo-temat, hur en brist i designsystemet rättas en gång i temat, vilka tokens och regler som gäller och vilken tillgänglighetsnivå som krävs.

Läs detta när: Du bygger eller ändrar något visuellt, ser att en kontroll bryter mot grinden, ska ändra färger, storlekar eller fokusring, eller ska uppgradera Astryx.

Hör ihop med: [Frontend](frontend.md), [Kvalitetsgrindar](quality-gates.md), [Arkitektur](architecture.md#frontendens-lager), [Beslut: Astryx i stället för shadcn](decisions/0001-astryx-over-shadcn.md), [Branding](branding.md)

## Astryx i korthet

Gränssnittet byggs av Astryx (`@astryxdesign/core`), ett designsystem med komponenter, layoutprimitiver, tokens och en CLI. Versionen är fastlåst exakt i `frontend/package.json` (kärnan, CLI:t och `@stylexjs/stylex`, som bara är en peer-beroende: inget skrivs i StyleX).

- Komponenterna levereras förkompilerade med en enda statisk `astryx.css` i cascade-skikt.
- CLI:t är källan till sanning om den installerade versionen. Den hostade Astryx-MCP:n dokumenterar den senaste utgåvan; när den och CLI:t skiljer sig åt har CLI:t rätt.
- Pre-1.0: uppgradera aldrig i en funktionsändring (se [Uppgradera Astryx](#uppgradera-astryx)).

Fastlåsta fakta om Astryx som formar koden:

| Fakta | Följd |
|---|---|
| `AppShell` renderar hoppa-till-innehåll-länken och en `role="main"`-region. | En sida renderar aldrig egen `<main>` eller egen hoppa-länk. |
| `Dialog` renderar en native `<dialog>` på plats, utan portal. `purpose="required"` stänger av Escape och bakgrundsstängning. `AlertDialog` har fast form: titel, beskrivning, avbryt och en handling. | Se [beslutet om täckskiktet](decisions/0004-native-dialogs-and-the-session-cover.md). |
| En `VStack` sträcker sina barn över hela bredden. | Begränsa innehållet med `Layout contentWidth` och justera handlingar med `hAlign="start"` eller en `HStack`. |
| Ett tema namnger typsnitt men laddar dem aldrig. | Inga tredjepartsförfrågningar för typsnitt. |
| Full återgivning: Chrome och Edge 125+, Safari 26+, Firefox 147+. På Chrome 114+, Safari 17+ och Firefox 125+ öppnas och stängs de lagrade ytorna (menyer, väljare, verktygstips) men placeras inte vid sin utlösare. | Äldre webbläsare fungerar men får oförankrade menyer; kontrolleras för hand på en riktig enhet inför en release. |

## Använd designsystemet

Alla kommandon körs från `frontend/` via `npm run astryx --`, aldrig via `npx @astryxdesign/cli` (som kan hitta en annan version).

| Kommando | Används för |
|---|---|
| `npm run astryx -- build "<idé>"` | Börja här: ger närmaste sidmall, block och komponenter. |
| `npm run astryx -- template <namn> --skeleton` | Studera ramen en mall föreslår. |
| `npm run astryx -- component <Namn>` | Props och exempel för varje komponent du använder. Gissa aldrig en prop. `--dense` ger en kortare form. |
| `npm run astryx -- docs <ämne>` | Referensdokument, till exempel `layout`, `tokens`, `color`, `typography`, `motion`. Läs `docs layout` innan en sida eller skärm. |
| `npm run astryx -- search "<fråga>"` | Sök komponenter, hooks, dokument och mallar. |
| `npm run astryx -- theme targets` | Vilka komponentdelar ett tema kan åsidosätta. |
| `npm run astryx -- doctor` | Kontrollerar att Astryx är rätt uppsatt (körs i CI). |
| `npm run astryx -- template --cdn <fil>.html` | Skriver en enda HTML-sida med Astryx utan bygge, för att prova en layoutidé. |

Regler som gäller all kod:

- Komponenter först. Ingen `<div>` för layout; komponenterna sköter layout och avstånd, sidramen inräknad.
- Stilning via komponentens props. Annars en CSS-modul med Astryx-tokens på de få specialytorna ([Frontend](frontend.md#konventioner)).
- Tokens för varje värde (`npm run astryx -- docs tokens`): inga hexfärger, inga pixelavstånd. Överstyr aldrig `--color-*` i `:root`.
- Ingen Tailwind-klass i ny eller portad kod. Författa inte StyleX (`stylex.create`, `xstyle`) och kör inte `astryx swizzle` (utkopiering av en komponents källa).
- Tät data är rader (`Table`, `List` och `Item`), aldrig kort runt listobjekt. Status är `StatusDot` eller `Token`, `Badge` är bara antal.
- Användarens egen text är svensk. Astryx egna ord (till exempel "Hoppa till innehåll") kommer ur `@astryxdesign/core/locales/sv-SE.json`.

## Eneo-temat

Temat är källan till allt som skiljer modulen från Astryx standard.

| Sökväg | Roll |
|---|---|
| `frontend/kit/theme/eneo.theme.ts` | Temakällan: accent, typografi, tokens, komponentåsidosättningar och anpassningar. **Det enda stället** en brist rättas. |
| `frontend/kit/theme/built/eneo.{css,js,d.ts}` | Genereras av `npm run theme:build`, är incheckade och redigeras aldrig för hand. De ligger i en egen mapp: bredvid källan skulle bundlern hitta `.ts`-filen och tyst använda stilar som byggs i webbläsaren. |
| `frontend/kit/ModuleProviders.tsx` | Tema, svenska texter och Nexts länk för alla sidor. |
| `frontend/kit/ModuleShell.tsx` | Sidans ram: toppfält, hoppa-länk, huvudregion. |
| `frontend/app/layers.css` | Skiktordningen `reset, tw-preflight, astryx-base, astryx-theme`. Importeras först, i en egen fil, eftersom webpack lyfter importer. |

Vad temat bestämmer:

- **Accent:** Sundsvalls blå `#004595` (mörkt läge `#52B1FF`), satt som explicita tokens (`--color-accent`, `--color-on-accent`). `color.accent` ger bara en tonpalett ur ett frö, inte själva fröet: `#004595` blev `#325BAF`.
- **Typsnitt:** systemtypsnitt i 16 px med skala 1,2, inga webbtypsnitt.
- **Pekmål:** under en grov pekare (`pointer: coarse`) höjs kontroller, menyrader och val till 44 px.
- **Fokusring** på fält, väljare och liknande (se nedan), och en läsbar etikett på felfärgen i mörkt läge.
- **Ordbrytning:** ett ord utan brytpunkt (en e-postadress som namn) bryts i stället för att nå utanför en 320 px-skärm.

Det finns inget runtime- eller byggberoende till `@sk-web-gui`; färgtokens och komponentvarianter utvecklas och granskas tillsammans med modulen.

Färgläget ägs av next-themes, inte av temat. Se [beslutet](decisions/0003-next-themes-owns-the-colour-mode.md).

Sundsvalls domänfärger (inspelningsröd, de sex talarfärgerna) ligger kvar som CSS-variabler i modulen (`frontend/app/globals.css`) tills en andra modul behöver dem. Hur organisationens märke ritas: [Arkitektur](architecture.md#var-organisationens-märke-kommer-in) och [Branding](branding.md).

## Rätta en brist i designsystemet

Ser du att en Astryx-kontroll bryter mot grinden eller huset (för liten pekyta, för svag fokusindikator, för låg kontrast), rätta den en gång i temat, aldrig vid ett enskilt anrop:

1. Läs felet i grinden ([Kvalitetsgrindar](quality-gates.md#läsa-ett-fel)) och notera vilken komponent och vilket tillstånd.
2. Hitta komponentens tema-mål med `npm run astryx -- theme targets <filter>`.
3. Lägg rättelsen i `frontend/kit/theme/eneo.theme.ts`: en token under `tokens`, en åsidosättning under `components` (till exempel `'text-input': {base: {':focus-within': focusRing}}`), eller en regel under `adaptations.rules` (till exempel `when: {pointer: 'coarse'}`).
4. Bygg om temat: `npm run theme:build`. Checka in både källan och `kit/theme/built/`; CI misslyckas om de skiljer sig åt.
5. Kör läget i grinden (`npm run test:a11y -- a11y.spec.ts -g "<läge>"`) och sedan `npm run test:prod`.
6. Skriv i commit-meddelandet vilket grindfynd rättelsen svarar på.

Exempel som redan finns i temat: fokusring på alla fält och väljare (annars visar de fokus bara som en kantfärg, vilket grindens 3:1-mätning avvisar), 44 px menyrader och val för pekskärmar, och en mörk etikett på felfärgen i mörkt läge (Astryx vita etikett är 3,76:1, den mörka 5,4:1). Kräver en rättelse en utkopierad eller förgrenad Astryx-komponent för att klara grinden är det inget temaärende utan ett stoppvillkor: rapportera det i stället.

## Tillgänglighetsnivån

| Krav | Mått | Bevis |
|---|---|---|
| WCAG 2.2 AA | Inga överträdelser i axe, namn på alla kontroller, kontrast, reflow vid 320 px och 200 % zoom, textavstånd | `npm run test:a11y` |
| Pekmål | 24 px med mus, 44 px med finger | `npm run test:a11y` |
| Synlig fokusindikator | Minst 3:1 förändring, inte skymd | `npm run test:a11y` (tangentbordsvandringarna) |
| Reducerad rörelse | Inga oändliga animationer | `npm run test:a11y` (projektet `reduced-motion`) |
| Tvingade färger | Allt går att använda | `npm run test:a11y` (projektet `forced-colors`) |
| Inga tredjepartsursprung | Inga typsnitt eller skript från andra origins | CSP i `frontend/next.config.mjs`, `npm run test:prod` |

Se [Kvalitetsgrindar](quality-gates.md) för vad grinden bevisar och inte bevisar.

## Uppgradera Astryx

Astryx är fastlåst exakt och uppgraderas aldrig i en funktionsändring. En uppgradering är en egen pull request:

1. Bumpa `@astryxdesign/core` och `@astryxdesign/cli` till samma exakta version (och `@stylexjs/stylex` till den version Astryx kräver).
2. `npm run astryx -- upgrade --from <gammal version>` visar kodmodifieringarna som en torrkörning; `--apply` skriver dem. Granska diffen.
3. `npm run astryx -- doctor`, sedan `npm run theme:build` och granska ändringen i `kit/theme/built/`.
4. Hela grinden (`npm run test:a11y`) och `npm run test:prod`.
5. Återställning är att backa pull requesten.

`frontend/AGENTS.md` är ett block som Astryx-CLI:t genererar; `upgrade` kan uppdatera det. Rör det inte för hand. Reglerna som gäller i just det här repot (att Tailwind inte används, att CSS-moduler är tillåtna på specialytor) står i repots rot-`AGENTS.md` och går före det genererade blocket där de skiljer sig.

## Migration (temporary, removed by bead .24)

- Under portningen ligger det gamla systemet kvar bredvid Astryx: `@layer tw-preflight` i `frontend/app/globals.css` gör att Tailwinds återställning inte plattar till Astryx, och `app/layers.css` bestämmer skiktordningen. Tailwind och Radix tas bort i portningens sista fas.
- Det äldre designunderlaget `design/DESIGN.md` och prototypen `design/prototyp.html` beskriver shadcn/Tailwind-stacken. De gäller inte för ny kod.
- Plan och beslutsunderlag: `docs/plans/2026-10-01-astryx-port-plan.md`, `docs/plans/2026-10-01-module-platform-design.md`.
