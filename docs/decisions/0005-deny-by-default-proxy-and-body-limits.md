# 0005. Proxy som nekar som standard, och gränser för storlek

## Sammanhang
 Webbläsaren får aldrig själv välja vad den ber Eneo om, eller med vilka credentials. Eneos API är brett och modulen behöver en handfull rutter. Modulen har en enda HTTP-klient mot Eneo för alla användare och varje anrop bär servicenyckeln: det en användare, en proxy eller ett skript lägger till i ett anrop, eller det Eneo svarar, får inte kunna nå någon annan användare eller växa utan gräns. Uppladdningar av långa möten är stora.

## Beslut

- **Proxyn nekar som standard, för sökvägar och för headers.** `/api/eneo/<sökväg>` släpper bara igenom metoder och sökvägar i `_PROXY_ROUTE_RULES` (`backend/app/main.py`), matchade som de stavas; allt annat är 403. Sökvägar som kan nå en annan rutt avvisas före matchningen och varje segment kodas om på vägen ut. Av webbläsarens headers går en uppräknad handfull vidare; credentials sätts ur sessionen. Mutationer kräver att `Origin` är modulens egen. [Backend](../backend.md#tillåtelselistan-för-eneo-anrop)
- **Uppladdning och filer har egna rutter:** Eneos lastbalanserare svarade med `ReadError` på webbläsarens råa multipart, och en signerad URL är en bärartoken som webbläsaren inte ska få. Uppladdningen läses först efter att session, origin och sidans användare kontrollerats.
- **Inget läses utan gräns.** Varje request-body har ett tak i en middleware före allt annat, uppladdningar har ett eget, och inget svar från Eneo läses förbi en gräns. Klienten lagrar inga cookies, följer ingen omdirigering och avvisar ett kodat svar. En uppladdning har en tidsgräns för hela vidarebefordran. [Backend: gränser](../backend.md#gränser)
- WebSocket-meddelanden från webbläsaren är högst 128 KiB (Eneos PCM-ramar är högst 64 KiB), i en konstant som bara `app.serve` skickar vidare.

## Konsekvenser

- Varje ny Eneo-rutt som webbläsaren ska nå kräver en rad på listan och ett test (en närliggande rutt ska nekas). Det är avsiktlig friktion. En header en ny rutt behöver läggs på samma sätt i `_FORWARDED_REQUEST_HEADERS`.
- Ett 413 från modulen säger vilken gräns (`max_body_bytes` eller `max_upload_bytes`), så att det går att skilja från Eneos egna gränser.
- JSON-anrop läses hela i minnet, upp till `MAX_BODY_BYTES`.
- Modulen har inga andra lager framför sina gränser än driftsättningens egna: [Drift](../operations.md#vad-som-står-framför-modulen).
