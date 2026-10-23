# Tal till text

Gör text av ett möte. Spela in ett samtal i webbläsaren eller ladda upp en ljudfil. Modulen skickar ljudet till ett flöde i Eneo, och flödet avgör vad du får tillbaka: en transkribering, en sammanfattning eller filer.

**Ska du sätta upp modulen?** Följ [Kom igång](kom-igang.md): sex steg från Eneo till en modul med er logga och färg.

Användare öppnar modulen på den adress organisationen har satt upp och loggar in med sitt Eneo-konto.

## Så fungerar det

1. **Du lägger in ljudet.** Spela in i webbläsaren och se texten växa medan du pratar, eller ladda upp en ljudfil. Inspelningen sparas på enheten tills Eneo har tagit emot den, så den finns kvar efter en omladdning eller ett avbrott.
2. **Ett flöde i Eneo tar över.** Modulen skickar ljudet till ett publicerat flöde i organisationens Eneo.
3. **Du granskar och får resultatet.** Har flödet ett granskningssteg godkänner du talarna eller texten först.

Modulen är en egen webbapplikation bredvid Eneo, utan egen databas: flöden, körningar och resultat ligger i Eneo.

## Läs vidare

- [Kom igång](kom-igang.md): koppla modulen till Eneo och driftsätt den.
- [Byt organisation](branding.md): namn, logga och accentfärg.
- [Drift](operations.md): miljövariabler, proxy, uppgraderingar och felsökning.
- [Inspelaren](recording.md): vad som händer när mikrofonen, lagringen eller nätet sviker.
- [Lokal utveckling](development.md): kör modulen på din dator, med eller utan Docker.
- [Arkitektur](architecture.md) och [API-referens](api-referens.md): hur webbläsaren, modulen och Eneo hänger ihop.

Bygger du en egen modul? [eneo-module-kit](https://github.com/eneo-ai/eneo-module-kit) samlar inloggningen mot Eneo, sessionen, proxyn och gränssnittet, och tas fram ur den här modulen. Källkoden: [modulen](https://github.com/eneo-ai/eneo-mod-speech-to-text) och [Eneo](https://github.com/eneo-ai/eneo).
