# 0006. Organisationens märke och accent är driftsinställningar

Syfte: Fastställa att organisationens namn, logotyp och accentfärg väljs vid driftsättning, inte vid bygget, hur det visas utan att fel organisation syns, och varför accentfärgen måste nå 4,5:1.

Läs detta när: En annan kommun eller myndighet ska använda modulen, du ändrar sidhuvudets märke eller modulens accentfärg, eller du undrar varför varje sida renderas per request och varför en färg kan stoppa start.

Hör ihop med: [Byt organisation](../branding.md), [Drift](../operations.md#egen-organisation-i-sidhuvudet), [Backend](../backend.md#branding), [Arkitektur](../architecture.md#var-organisationens-märke-och-accent-kommer-in), [Beslutslogg](README.md)

Status: Accepterat, infört. Datum: 2026-09-23 för märket (`b4166fa`), utökat 2026-10-01 med accentfärgen (`86bb55e`).

## Sammanhang

Modulen byggdes för Sundsvalls kommun med dess logotyp i sidhuvudet och dess blå som accent, men andra kommuner och myndigheter kör samma image. Ett eget bygge per organisation skulle kräva egna images och en egen byggkedja.

Accentfärgen är inte dekoration. Den är färgen på knappar, länkar och ikoner, på fokusramen, på valda rader och på nivåmätaren. En accent som inte går att läsa mot sidan gör länkar och text oläsliga och fokus osynligt, och en organisation kan inte själv se det innan det är i drift.

## Beslut

Organisationen bredvid "Tal till text" är en inställning för driftsättningen (`ORGANIZATION_NAME`, `ORGANIZATION_LOGO`, `ORGANIZATION_LOGO_DARK`, `SHOW_ORGANIZATION`, `ORGANIZATION_ACCENT`, `ORGANIZATION_ACCENT_DARK`), inte en byggparameter.

**Märket**

- Backend läser inställningarna vid start (`backend/app/config.py`). Logotypen är en monterad fil (SVG eller PNG, högst 1 MiB), kontrollerad på namn och innehåll. Namnet är logons alternativtext.
- `GET /api/branding` och `GET /api/branding/logo/{light|dark}` kräver ingen session, eftersom inloggningssidan visar organisationen innan det finns en. Logon serveras från samma origin, eftersom sidans CSP bara tillåter egna bilder, med en egen sandlåde-CSP så att en SVG som öppnas för sig inte kör något i modulens origin.
- Rotlayouten läser märket per request och renderar det i första HTML:en, så att ingen sida visar en kommuns märke före en annans. Läsningen har en tidsgräns på 2 sekunder: därefter visas produktnamnet ensamt, för märket är valfritt och en stannad backend får inte hålla sidan.
- Utan inställningar visas Sundsvalls kommun med sin medföljande logotyp. Ett namn utan logotyp visas som text, aldrig bredvid Sundsvalls logotyp. En fil som inte kan användas loggas en gång vid start och namnet står i dess ställe. `SHOW_ORGANIZATION=false` visar bara "Tal till text".

**Accentfärgen**

- `ORGANIZATION_ACCENT` (`#RRGGBB`) ersätter modulens blå (`#004595`) överallt, i ljust och mörkt läge. `ORGANIZATION_ACCENT_DARK` anger mörkt läge; utelämnad härleds den ur den ljusa med samma nyans och mättnad (`backend/app/accent.py`).
- **Ett krav, 4,5:1.** Backend kontrollerar färgen mot designsystemets ytor när den startar: texten på accenten (vit eller nästan svart, den som syns bäst), accenten mot sidans ytor i båda lägena, och den sekundära texten på accentens ton (valda rader). Det är WCAG-kontrast, och det är högre än WCAG:s 3:1 för ramar och ikoner. Skälet är att accenten också är text- och länkfärgen: ett enda krav som håller för det värsta bruket är enklare än ett per användning, och det håller fokusramen läsbar på köpet.
- En färg som inte når kravet, eller inte är `#RRGGBB`, stoppar start med ett enda svenskt felmeddelande som säger vad som mättes, vilket värde det fick och vad operatören ska göra. Att stoppa är avsiktligt: ett fel som syns vid driftsättningen är bättre än oläsliga länkar hos användarna.
- Accenten når sidan som en stilmall, `GET /api/branding/theme.css`, som backend formaterar bara ur en redan kontrollerad färg i en fast mall (en tom kommentar utan accent). Rotlayouten länkar den i `<head>`: en vanlig same-origin-länk håller första målningen tills den är hämtad, så ingen bildruta visar den gamla färgen, och en strikt `style-src 'self'` släpper in den. Den får cachas i fem minuter (`Cache-Control: max-age=300`, `ETag`).
- Allt annat i utseendet är modulens: neutrala ytor och textfärger, statusfärger, talarfärger, typsnitt och layout. Bara accenten och märket är organisationens.

## Konsekvenser

- Alla sidor renderas per request (`force-dynamic` i `frontend/app/layout.tsx`).
- Ett byte av märke syns först efter den omstart som läser filen; logon serveras med `Cache-Control: no-cache`. En ny accent syns efter omstarten och när webbläsarens kopia av stilmallen gått ut (högst fem minuter).
- En operatör kan göra så att backend inte startar, med en färg som är för ljus eller för mörk. Felet står i loggen och förklaras i [Byt organisation](../branding.md#felmeddelanden-vid-start).
- Nya användningar av accenten (en komponent som använder den som text eller ram) omfattas av samma krav. Grindens branding-tillstånd (`npm run test:a11y:branding`) kontrollerar att ingenting i sidan behåller den gamla blå färgen.
- En organisations egna statusfärger eller talarfärger är inte möjliga utan kod.
