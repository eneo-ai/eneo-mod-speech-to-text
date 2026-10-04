# 0005. Proxy som nekar som standard, och gränser för storlek

Syfte: Fastställa att BFF:en bara släpper igenom uppräknade Eneo-rutter och headers, att inget läses utan gräns, och var gränserna för storlek och tid sitter.

Läs detta när: Du ska låta webbläsaren nå en ny Eneo-rutt, ändra en uppladdningsgräns eller en timeout, eller undrar var en kapad, nekad eller avbruten uppladdning kan komma ifrån.

Hör ihop med: [Backend](../backend.md#tillåtelselistan-för-eneo-anrop), [Backend: gränser](../backend.md#gränser), [Drift](../operations.md#vid-problem), [Inloggning och session](../auth-and-session.md), [Beslutslogg](README.md)

Status: Accepterat, infört. Datum: 2026-08-18 (proxyn, `7a89b16`), 2026-09-11 (Nexts tak för body, `1a518c5`), 2026-09-23 (WebSocket-gränserna, `95b5078`), 2026-10-01 (gränserna i BFF:en: `50ee50a`, `2ade3dc`, `a407ef7`).

## Sammanhang

Webbläsaren får aldrig själv välja vad den ber Eneo om, eller med vilka credentials. Eneos API är brett, och modulen behöver en handfull rutter. Uppladdningar av långa möten är stora, och varje hopp mellan webbläsaren och Eneo har sina egna gränser som fel visar sig först i produktion.

Modulen har en enda HTTP-klient mot Eneo för alla användare, och varje anrop bär servicenyckeln. Det som en användare, en proxy eller ett skript lägger till i ett anrop, eller det som Eneo svarar, får därför inte kunna nå någon annan användare eller växa utan gräns.

## Beslut

**Proxyn nekar som standard, för sökvägar och för headers.** `/api/eneo/<sökväg>` släpper bara igenom metoder och sökvägar som står i `_PROXY_ROUTE_RULES` (`backend/app/main.py`); allt annat får 403. Sökvägar som kan nå en annan rutt avvisas före matchningen, och varje segment kodas om på vägen ut. Av webbläsarens headers går bara en uppräknad handfull vidare, och modulens credentials sätts ur sessionen. Mutationer kräver att `Origin` är modulens egen. Detaljer och tabell: [Backend](../backend.md#tillåtelselistan-för-eneo-anrop).

**Uppladdning och filer har egna rutter** i stället för den allmänna proxyn: Eneos lastbalanserare svarade med `ReadError` på webbläsarens råa multipart, och en signerad URL är en bärartoken som webbläsaren inte ska få. Uppladdningen läses först efter att session, origin och sidans användare kontrollerats.

**Inget läses utan gräns.** Varje request-body har ett tak i en middleware före allt annat, uppladdningar har ett eget, och inget svar från Eneo läses förbi en gräns. Klienten lagrar inga cookies, följer ingen omdirigering och avvisar ett kodat svar. En uppladdning har en tidsgräns för hela vidarebefordran. Värdena: [Backend: gränser](../backend.md#gränser).

**Gränserna sätts där hoppet är.** Utöver BFF:ens egna:

| Gräns | Värde | Var |
|---|---|---|
| Body genom Nexts rewrite | 2 GB (`experimental.proxyClientMaxBodySize`) | `frontend/next.config.mjs`. Standard är 10 MB och en större body kapades tyst, så att en ljuduppladdning gick sönder hos Eneo. Filstorleken begränsas av Eneos flödeskontrakt (`max_file_size_bytes`) och av modulens `MAX_UPLOAD_BYTES`. |
| Tystnad genom Nexts rewrite | 31 minuter (`experimental.proxyTimeout`) | Följer uppladdningens budget: `UPLOAD_PROXY_TIMEOUT_SECONDS` (1800 s) plus marginal. Standard är 30 s, och då nådde uppladdningen 100 % och föll fast Eneo sparat filen. |
| WebSocket-meddelande från webbläsaren | 128 KiB, 16 i kö | Alla startsätt, med ett test att de är överens (`backend/tests/test_live_relay.py`). Eneos PCM-ramar är högst 64 KiB. |

## Konsekvenser

- Varje ny Eneo-rutt som webbläsaren ska nå kräver en rad på listan och ett test (en närliggande rutt ska nekas). Det är avsiktligt friktion. En header som en ny rutt behöver läggs på samma sätt i `_FORWARDED_REQUEST_HEADERS`.
- Tak och timeouts måste hållas ihop: höjer du `UPLOAD_PROXY_TIMEOUT_SECONDS` höj `proxyTimeout` över den. Nexts klonade body hålls i minnet under uppladdningen, så 2 GB är också ett minnestak per upload i Next-processen.
- Ett 413 från modulen säger vilken gräns (`max_body_bytes` eller `max_upload_bytes`), så att det går att skilja från Eneos egna gränser.
- JSON-anrop läses hela i minnet, upp till `MAX_BODY_BYTES`.
- Om Next-servern tas bort (Plan B i [0002](0002-fastapi-bff-kept.md), inte påbörjat) försvinner Nexts två tak; BFF:ens egna tak ligger kvar och blir de enda.
