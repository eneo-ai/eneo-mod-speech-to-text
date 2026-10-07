# 0008. FastAPI serverar det byggda gränssnittet, i en process

## Sammanhang

Backenden (BFF:en) är modulens säkerhetsgräns: ticketväxling, förnyelse av token, tillåtelselistan mot Eneo, filströmning och WebSocket-reläets gränser. Den är skriven och testad i Python. Gränssnittet behöver ingen server vid körning: det är en app på klientsidan som byggs till statiska filer. Sessionslagret ligger i processens minne, så det får finnas en process.

## Beslut

Gränssnittet byggs med Vite till `frontend/dist/`, och imagen innehåller bara de byggda filerna. `python -m app.serve` serverar dem och API:t på port 3001: en container, en uvicorn-process, en arbetsprocess. Säkerhetsheadrarna och cachereglerna sätts på varje svar på ett ställe, CSP:n tillåter varken inline-skript eller inline-stilar, och bygget bär ingen driftsinställning ([Backend](../backend.md#statiska-filer-och-säkerhetsheaders)).

## Konsekvenser

- Modulen kan inte köras i flera repliker eller bytas utan avbrott: sessionerna följer processen. Driftsättningen stoppar den gamla containern innan den nya startar ([Drift](../operations.md#uppgradera)).
- Ett byte av gränssnitt är ett byte av image: filerna indexeras vid start, och en fil som tillkommer i en körande container serveras inte.
- Frontendens routing, titlar, fokus och navigeringsspärr ligger i klienten ([Frontend](../frontend.md#routing-titlar-och-fokus)); backenden vet bara att ett sista segment utan punkt är sidan.
