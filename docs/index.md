---
layout: home
title: Tal till text
titleTemplate: false
hero:
  name: Tal till text
  text: Gör text av ett möte
  tagline: "Spela in ett samtal i webbläsaren eller ladda upp en ljudfil. Modulen skickar ljudet till ett flöde i Eneo, och flödet avgör vad du får tillbaka: ett transkript, en sammanfattning eller filer."
  actions:
    - theme: brand
      text: Driftsätt modulen
      link: /operations
    - theme: alt
      text: Läs mer om Eneo
      link: https://eneo.ai
---

## Så fungerar det

1. **Du lägger in ljudet.** Spela in i webbläsaren och se texten växa medan du pratar, eller ladda upp en ljudfil som du redan har.
2. **Ett flöde i Eneo bearbetar det.** Modulen skickar ljudet till ett publicerat flöde i din organisations Eneo. Flödet bestämmer vad som händer med ljudet.
3. **Du får resultatet.** Det som flödet är gjort för att ge: ett transkript, en sammanfattning eller filer att ladda ner.

## Modulen och Eneo

Modulen är en egen webbapplikation som körs bredvid Eneo. Du loggar in med ditt vanliga Eneo-konto, och allt som ska sparas, som flöden, körningar och resultat, ligger kvar i Eneo. Modulen har ingen egen databas.

Den här webbplatsen är modulens dokumentation. Själva modulen öppnar du från din organisations Eneo.

## Läs vidare

- [Driftsätt modulen](operations.md): köra imagen i Dokploy eller Portainer, miljövariabler, uppdateringar och felsökning.
- [Byt organisation](branding.md): namn, logga och accentfärg för din kommun eller myndighet.
- [Utveckla lokalt](development.md): starta modulen på din dator, med eller utan Docker.
- [API-referens](api-referens.md): vilka anrop modulen släpper igenom till Eneo.
- [Arkitektur](architecture.md): hur webbläsaren, modulen och Eneo hänger ihop.

## Är du också intresserad av att bygga moduler?

Eneos modulkit samlar det varje modul behöver: inloggningen mot Eneo, sessionen, proxyn som lägger på rätt nycklar, ett tillgängligt gränssnitt och en container-image. Kitet är under uppbyggnad, och den här modulen är källan det tas fram ur. [Se eneo-module-kit på GitHub](https://github.com/eneo-ai/eneo-module-kit).

## Källkod

[Eneo på GitHub](https://github.com/eneo-ai/eneo), [organisationens projekt](https://github.com/eneo-ai) och [den här modulens källkod](https://github.com/eneo-ai/eneo-mod-speech-to-text).
