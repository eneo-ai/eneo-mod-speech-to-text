# 0006. Organisationens märke är en driftsinställning

Syfte: Fastställa att organisationens namn och logotyp väljs vid driftsättning, inte vid bygget, och hur det visas utan att fel organisation syns.

Läs detta när: En annan kommun eller myndighet ska använda modulen, du ändrar sidhuvudets märke, eller du undrar varför varje sida renderas per request.

Hör ihop med: [Drift](../operations.md#egen-organisation-i-sidhuvudet), [Backend](../backend.md#branding), [Arkitektur](../architecture.md#var-organisationens-märke-kommer-in), [Beslutslogg](README.md)

Status: Accepterat, infört. Datum: 2026-09-23 (`b4166fa`).

## Sammanhang

Modulen byggdes för Sundsvalls kommun med dess logotyp i sidhuvudet, men andra kommuner och myndigheter kör samma image. Ett eget bygge per organisation skulle kräva egna images och en egen byggkedja.

## Beslut

Organisationen bredvid "Tal till text" är en inställning för driftsättningen (`ORGANIZATION_NAME`, `ORGANIZATION_LOGO`, `ORGANIZATION_LOGO_DARK`, `SHOW_ORGANIZATION`), inte en byggparameter.

- Backend läser inställningarna vid start (`backend/app/config.py`). Logotypen är en monterad fil (SVG eller PNG, högst 1 MiB), kontrollerad på namn och innehåll. Namnet är logons alternativtext.
- `GET /api/branding` och `GET /api/branding/logo/{light|dark}` kräver ingen session, eftersom inloggningssidan visar organisationen innan det finns en. Logon serveras från samma origin, eftersom sidans CSP bara tillåter egna bilder, med en egen sandlåde-CSP så att en SVG som öppnas för sig inte kör något i modulens origin.
- Rotlayouten läser märket per request och renderar det i första HTML:en, så att ingen sida visar en kommuns märke före en annans. Läsningen har en tidsgräns på 2 sekunder: därefter visas produktnamnet ensamt, för märket är valfritt och en stannad backend får inte hålla sidan.
- Utan inställningar visas Sundsvalls kommun med sin medföljande logotyp. Ett namn utan logotyp visas som text, aldrig bredvid Sundsvalls logotyp. En fil som inte kan användas loggas en gång vid start och namnet står i dess ställe. `SHOW_ORGANIZATION=false` visar bara "Tal till text".
- Färgerna följer modulens tema; märket påverkar dem inte.

## Konsekvenser

- Alla sidor renderas per request (`force-dynamic` i `frontend/app/layout.tsx`).
- Ett byte av märke syns först efter den omstart som läser filen; logon serveras med `Cache-Control: no-cache`.
- En organisations accent och temat är en separat fråga från märket.
