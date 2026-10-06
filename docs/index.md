# Tal till text

Gör text av ett möte. Spela in ett samtal i webbläsaren eller ladda upp en ljudfil. Modulen skickar ljudet till ett flöde i Eneo, och flödet avgör vad du får tillbaka: en transkribering, en sammanfattning eller filer.

Det här är dokumentationen. Själva modulen öppnar du på den adress din organisation har satt upp, och du loggar in med ditt Eneo-konto.

[Driftsätt modulen](operations.md) eller [läs mer om Eneo](https://eneo.ai).

## Så fungerar det

1. **Du lägger in ljudet.** Spela in i webbläsaren och se texten växa medan du pratar, eller ladda upp en ljudfil.
2. **Ett flöde i Eneo tar över.** Modulen skickar ljudet till ett publicerat flöde i din organisations Eneo.
3. **Du får resultatet.** Det visas i modulen när flödet är klart.

## Modulen och Eneo

Modulen är en egen webbapplikation som körs bredvid Eneo. Du loggar in med ditt vanliga Eneo-konto, och allt som ska sparas, som flöden, körningar och resultat, ligger kvar i Eneo. Modulen har ingen egen databas.

## Läs vidare

- [Driftsätt modulen](operations.md): köra imagen i Dokploy eller Portainer, miljövariabler, uppdateringar och felsökning.
- [Byt organisation](branding.md): namn, logga och accentfärg för din kommun eller myndighet.
- [Lokal utveckling](development.md): starta modulen på din dator, med eller utan Docker.
- [API-referens](api-referens.md): vilka anrop modulen släpper igenom till Eneo.
- [Arkitektur](architecture.md): hur webbläsaren, modulen och Eneo hänger ihop.

## Är du också intresserad av att bygga moduler?

Eneos modulkit samlar det varje modul behöver: inloggningen mot Eneo, sessionen, proxyn som lägger på rätt nycklar, ett tillgängligt gränssnitt och en container-image. Kitet är under uppbyggnad, och den här modulen är källan det tas fram ur. [Se eneo-module-kit på GitHub](https://github.com/eneo-ai/eneo-module-kit).

## Källkod

[Eneo på GitHub](https://github.com/eneo-ai/eneo), [Eneo-organisationen på GitHub](https://github.com/eneo-ai) och [den här modulens källkod](https://github.com/eneo-ai/eneo-mod-speech-to-text).
