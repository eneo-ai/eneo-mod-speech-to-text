# 0008. FastAPI serverar det byggda gränssnittet, i en process

## Sammanhang

Backenden (BFF:en) är modulens säkerhetsgräns: state-cookie och ticketväxling, förnyelse av token, tillåtelselistan mot Eneo, Range-strömning och WebSocket-reläets gränser. Den är skriven och testad i Python (`backend/app/`, `backend/tests/`). Gränssnittet behöver ingen server vid körning: det är en app på klientsidan som byggs till statiska filer. Sessionslagret ligger i processens minne, så det får finnas en process.

## Beslut

Gränssnittet byggs med Vite till `frontend/dist/`, och imagen innehåller bara de byggda filerna. `python -m app.serve` serverar dem och API:t på port 3001: en container, en uvicorn-process, en arbetsprocess. Det som följer:

- **Backenden äger svaren.** Säkerhetsheadrarna, CSP:n och cachereglerna sätts på varje svar på ett ställe (`backend/app/web.py`). CSP:n tillåter varken inline-skript eller inline-stilar, så sidan har ingen: färgläget sätts av en egen fil före första målningen, och organisationens märke skrivs av backenden i en tom markör i `index.html` vid start. CSP:n är försvar på djupet, inte det skydd som bär.
- **En saknad fil är ett 404, aldrig sidan.** En okänd `/api/...`-sökväg och en `/assets/...`-fil som inte finns svarar med JSON, så att en flik som stått öppen över en ny version inte får HTML i stället för kod. Djuplänkar (`/flows/<id>`) får `index.html`, och routern i webbläsaren tar vid. Ett snedstreck i slutet omdirigeras aldrig till en annan adress.
- **Starten vägrar utan ett byggt gränssnitt** (`STATIC_DIR/index.html`). `--api-only` är utvecklingsläget: Vites utvecklingsserver tar emot webbläsaren och vidarebefordrar `/api` till backenden.
- **Bygget bär ingen driftsinställning.** Inga `VITE_*`-variabler och ingen hemlighet i filerna; organisationens märke och accent läses av backenden vid start. Det enda bygget bestämmer är om granskningen av transkriptet finns med (`SPEAKER_REVIEW_ENABLED`). Utvecklingssidorna finns aldrig i `dist/`.

## Konsekvenser

- Modulen kan inte köras i flera repliker eller bytas utan avbrott: sessionerna följer processen. Driftsättningen stoppar den gamla containern innan den nya startar ([Drift](../operations.md#driftsätt-med-dokploy-eller-portainer)).
- Ett byte av gränssnitt är ett byte av image: filerna indexeras vid start och en fil som tillkommer i en körande container serveras inte.
- Varje svar går genom samma middleware, så en ny rutt får säkerhetsheadrarna utan att göra något. En rutt som behöver andra headers (en inline PDF, SVG-logons sandlåde-CSP) sätter dem själv och vinner.
- Frontendens routing, titlar, fokus och navigeringsspärr ligger i klienten ([Frontend](../frontend.md#routing-titlar-och-fokus)); backenden vet ingenting om sidornas adresser mer än att ett sista segment utan punkt är sidan.
