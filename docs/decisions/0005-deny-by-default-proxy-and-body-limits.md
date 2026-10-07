# 0005. Proxy som nekar som standard, och gränser för storlek

## Sammanhang

Webbläsaren får aldrig själv välja vad den ber Eneo om, eller med vilka credentials. Eneos API är brett och modulen behöver en handfull rutter. Modulen har en enda HTTP-klient mot Eneo för alla användare och varje anrop bär servicenyckeln: det en användare, en proxy eller ett skript lägger till i ett anrop, eller det Eneo svarar, får inte kunna nå någon annan användare eller växa utan gräns. Uppladdningar av långa möten är stora, och en signerad fil-URL är en bärartoken som webbläsaren inte ska få.

## Beslut

- **Proxyn nekar som standard**, för sökvägar och för headers: bara uppräknade metoder och sökvägar går igenom, och bara en uppräknad handfull av webbläsarens headers; credentials sätts ur sessionen. [Backend](../backend.md#tillåtelselistan-för-eneo-anrop)
- **Uppladdning och filer har egna rutter**, och uppladdningen läses först efter att session, origin och sidans användare kontrollerats.
- **Inget läses utan gräns:** varje request-body har ett tak före allt annat, och inget svar från Eneo läses förbi en gräns. [Backend: gränser](../backend.md#gränser)

## Konsekvenser

- Varje ny Eneo-rutt som webbläsaren ska nå kräver en rad på listan och ett test (en närliggande rutt ska nekas). Det är avsiktlig friktion.
- JSON-anrop läses hela i minnet, upp till `MAX_BODY_BYTES`.
