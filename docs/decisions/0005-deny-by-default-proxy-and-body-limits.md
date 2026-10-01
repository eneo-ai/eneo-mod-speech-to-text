# 0005. Proxy som nekar som standard, och gränser för storlek

Syfte: Fastställa att BFF:en bara släpper igenom uppräknade Eneo-rutter, och vilka gränser för storlek och tid som gäller var.

Läs detta när: Du ska låta webbläsaren nå en ny Eneo-rutt, ändra en uppladdningsgräns eller en timeout, eller undrar var en kapad eller avbruten uppladdning kan komma ifrån.

Hör ihop med: [Backend](../backend.md#tillåtelselistan-för-eneo-anrop), [Drift](../operations.md#vid-problem), [Inloggning och session](../auth-and-session.md), [Beslutslogg](README.md)

Status: Accepterat, infört. Datum: 2026-08-18 (proxyn, `7a89b16`), 2026-09-11 (taket för body, `1a518c5`), 2026-09-23 (WebSocket-gränserna, `95b5078`).

## Sammanhang

Webbläsaren får aldrig själv välja vad den ber Eneo om, eller med vilka credentials. Eneos API är brett, och modulen behöver en handfull rutter. Uppladdningar av långa möten är stora, och varje hopp mellan webbläsaren och Eneo har sina egna gränser som fel visar sig först i produktion.

## Beslut

**Proxyn nekar som standard.** `/api/eneo/<sökväg>` släpper bara igenom metoder och sökvägar som står i `_PROXY_ROUTE_RULES` (`backend/app/main.py`). Allt annat får 403. Sökvägar med `.`/`..`-segment, kodade varianter, `?` eller `#` avvisas före matchningen. Webbläsarens credentials byts mot modulens, och en mutation kräver att `Origin` är modulens egen. Tabellen finns i [Backend](../backend.md#tillåtelselistan-för-eneo-anrop).

**Uppladdning och filer har egna rutter** i stället för den allmänna proxyn: Eneos lastbalanserare svarade med `ReadError` på webbläsarens råa multipart, och en signerad URL är en bärartoken som webbläsaren inte ska få.

**Gränserna sätts där hoppet är:**

| Gräns | Värde | Var |
|---|---|---|
| Body genom Nexts rewrite | 2 GB (`experimental.proxyClientMaxBodySize`) | `frontend/next.config.mjs`. Standard är 10 MB och en större body kapades tyst, så att en ljuduppladdning gick sönder hos Eneo. Filstorleken begränsas av Eneos flödeskontrakt (`max_file_size_bytes`), inte här. |
| Tystnad genom Nexts rewrite | 31 minuter (`experimental.proxyTimeout`) | Följer uppladdningens budget: `UPLOAD_PROXY_TIMEOUT_SECONDS` (1800 s) plus marginal. Standard är 30 s, och då nådde uppladdningen 100 % och föll fast Eneo sparat filen. |
| Uppladdning backend till Eneo | `UPLOAD_PROXY_TIMEOUT_SECONDS`, standard 1800 | `backend/app/config.py` |
| WebSocket-meddelande från webbläsaren | 128 KiB, 16 i kö | Alla startsätt, med ett test att de är överens (`backend/tests/test_live_relay.py`). Eneos PCM-ramar är högst 64 KiB. |
| Logotyp | 1 MiB, bara SVG och PNG | `backend/app/config.py` |

## Konsekvenser

- Varje ny Eneo-rutt som webbläsaren ska nå kräver en rad på listan och ett test (en närliggande rutt ska nekas). Det är avsiktligt friktion.
- Tak och timeouts måste hållas ihop: höjer du `UPLOAD_PROXY_TIMEOUT_SECONDS` höj `proxyTimeout` över den. Nexts klonade body hålls i minnet under uppladdningen, så 2 GB är också ett minnestak per upload i Next-processen.
- BFF:en har inget eget tak för den allmänna proxyns request-body: den läses hel i minnet. Taket kommer från Next. Ett eget tak är inte infört.
- Om Next-servern tas bort ([0002](0002-fastapi-bff-kept.md)) försvinner det första och andra taket; då måste motsvarande gränser sättas i BFF:en.
