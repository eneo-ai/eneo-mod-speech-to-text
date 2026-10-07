# Backend (BFF)

Modulens backend är en FastAPI-app i en process. Den håller inloggningen, släpper bara igenom uppräknade anrop till Eneo, strömmar filer, relayar live-text och serverar det byggda gränssnittet.

## Var saker finns

| Sökväg | Innehåll |
|---|---|
| `backend/app/serve.py` | Starten: `python -m app.serve`. |
| `backend/app/main.py` | Appen: rutterna, tillåtelselistan mot Eneo (`PROXY_ROUTES`), uppladdningarna, filströmmarna, live-reläet. |
| `backend/app/resumable.py` | Tillfälliga filer för återupptagbar uppladdning: bekräftad position, ägare, utgångstid och kvittens efter vidarebefordran. |
| `backend/app/web.py`, `backend/app/security_headers.json` | Säkerhetsheaders på varje svar och serveringen av det byggda gränssnittet. |
| `backend/app/module_auth.py` | Inloggning, sessionslager, kontroll av session, origin och sidans användare. |
| `backend/app/upstream.py` | Den enda HTTP-klienten mot Eneo. |
| `backend/app/config.py` | Alla inställningar och deras validering vid start. Värdena: [Drift](operations.md#miljövariabler). |

Hela kartan över repot står i `AGENTS.md`. Testerna: [Tester](quality-gates.md).

## Starten

`python -m app.serve` är det enda sättet att starta backenden, i imagen och vid utveckling.

- **En arbetsprocess.** Sessionslagret är processlokalt, så en andra process skulle skicka personer fel. Starten vägrar ett försök att ändra det. Kör aldrig `uvicorn` direkt: då gäller varken arbetsprocessen eller WebSocket-gränsen.
- Ingen accesslogg (callbackens URL bär en engångsticket) och inget `Server`-huvud.
- Utan `--api-only` kräver starten att `STATIC_DIR` pekar på en mapp med det byggda gränssnittets `index.html`; en driftsättning utan sida är en misslyckad start. `--api-only` är för utveckling mot Vite och för tester.

## Rutter

Varje rutt, med metod, om den kräver session och origin, svar och felkoder, står i [API-referens](api-referens.md). Den ritas ur `docs/api/openapi.json`, som skrivs ur appen med `python export_openapi.py` i `backend/`; ett test misslyckas när filen skiljer sig från appen. WebSocketen `/api/live/{flow_id}/{step_id}` beskrivs under [Live-reläet](#live-reläet).

- Rutterna matchas som de stavas: en variant med eller utan avslutande snedstreck som inte är en rutt är 404, aldrig en omdirigering. FastAPIs egna dokumentationsrutter finns inte.
- Allt som ändrar något under `/api/eneo/` och live-socketen kräver att sidan namnger sessionens användare ([Sidans användare](auth-and-session.md#sidans-användare-i-en-gammal-flik)), och att `Origin` är `MODULE_PUBLIC_URL`.
- Varje HTTP-rutt har ett tak för request-body, se [Gränser](#gränser).

## Tillåtelselistan för Eneo-anrop

Webbläsarens `/api/eneo/<sökväg>` blir `{ENEO_BACKEND_URL}/api/v1/<sökväg>`. Bara metoder och sökvägar i `PROXY_ROUTES` (`backend/app/main.py`) går igenom, matchade som de stavas; allt annat får `403 Eneo resource is not exposed`. Listan med alla poster finns i [API-referens](api-referens.md) under "Eneo".

- **Sökvägen.** En sökväg med `?`, `#`, ett kontrolltecken, ett bakstreck eller ett segment som efter avkodning är `.` eller `..` avvisas före matchningen, och varje segment kodas om när URL:en till Eneo byggs: ett `%2F` i ett id blir ett id och ingen sökvägsgräns hos Eneo.
- **Request-headers.** Bara `Accept`, `Accept-Language`, `Content-Type`, `Idempotency-Key`, `If-Match` och `If-None-Match` från webbläsaren går vidare. Allt annat tas bort, `Cookie` och `Authorization` inräknade. Modulens credentials sätts ur sessionen.
- **Svars-headers.** Eneos `Set-Cookie`, `Location` och säkerhets- och cacheheaders skickas inte tillbaka: modulens säkerhetsheaders och cachepolicy (inget lagras under `/api`) är inte Eneos att ersätta.

**Lägga till en post.** Lägg en rad i `PROXY_ROUTES` med exakt de metoder och den sökväg som behövs, med avslutande snedstreck och ett eget namn för varje id; en text i `ENEO_SUMMARIES` i `backend/export_openapi.py`; kör `python export_openapi.py` i `backend/`. Lägg ett test i `backend/tests/test_eneo_proxy_auth.py`: rutten når Eneo, och en närliggande rutt (annan metod, extra segment, varianten utan snedstreck) nekas. Filer laddas upp och strömmas med de särskilda rutterna, inte med listan. En header en ny rutt behöver läggs i `_FORWARDED_REQUEST_HEADERS`.

## Gränser

Värdena och reglerna för dem står i [Drift](operations.md#miljövariabler).

| Gräns | Gäller | Överskridet ger |
|---|---|---|
| `MAX_BODY_BYTES` | Varje request-body utom uppladdningarna. | 413 med `max_body_bytes` |
| `MAX_UPLOAD_BYTES` | En `multipart/form-data` till uppladdningsrutten. | 413 med `max_upload_bytes`; 411 utan `Content-Length` |
| `MAX_RESPONSE_BYTES` | Ett enskilt svar från Eneo som modulen läser; en fil som strömmas räknas inte. | `502 upstream_too_large` |
| små svar, 1 MiB | Svar som bär en token eller en URL. | Ett misslyckat anrop, till exempel `502 upstream_invalid` |
| `UPLOAD_PROXY_TIMEOUT_SECONDS` | Hela vidarebefordran av en uppladdning. | `504 upstream_upload_timeout` |
| WebSocket-meddelande, 128 KiB | Webbläsarens live-socket. | stängning med 1009 |

Taket för request-body sitter först i kedjan (`backend/app/limits.py`), före sessionskontrollen, och räknar de bytes som faktiskt kommer. `max_body_bytes` eller `max_upload_bytes` i ett 413-svar visar att gränsen är modulens och inte Eneos egen (ett flödes `max_file_size_bytes` ger också 413).

## Uppladdningar

Ljud laddas upp genom en egen rutt, `/api/eneo/flows/{flow_id}/steps/{step_id}/runtime-files/`, i stället för den allmänna proxyn: Eneos lastbalanserare avvisade webbläsarens råa multipart-bytes, så BFF:en tar emot filen på disk och bygger om anropet. Session, origin och sidans användare kontrolleras innan en enda byte av bodyn läses, och bodyn måste vara exakt en fil, `upload_file`. En fil som blivit hel skickas klart även om webbläsaren går, eftersom ett avbrott mitt i kunde lämna Eneo med en del av filen. Svaren och felkoderna: [API-referens](api-referens.md).

Webbläsaren använder den rutten för filer upp till 4 MiB. Större filer skickas genom `/api/uploads/{flow_id}/{step_id}/{upload_id}`: `PUT` skapar eller hittar resursen, `PATCH` lägger till en del och `GET` visar senast bekräftade position. En del är högst 4 MiB eller `MAX_BODY_BYTES`, om det är mindre. Bara hela delar bekräftas. `POST …/complete` kontrollerar körningskontraktet igen och lämnar den sammansatta filen vidare i ett enda multipart-anrop till Eneo. Ett upprepat färdigställande ger samma kvittens så länge den finns kvar. `DELETE` städar en fil vars vidarebefordran inte har börjat.

Varje resurs tillhör användaren och organisationen i sessionen samt det angivna flödet och steget. Filstorlek och stegets filinmatning kontrolleras mot Eneos körningskontrakt före mellanlagring och vidarebefordran. Eneo äger kontrollen av filtyp, inklusive formatens alternativa MIME-namn och kontroll av filinnehållet. Klienten finns i `frontend/lib/api.ts`; tillstånd och städning finns i `backend/app/resumable.py`. [Driftguiden](operations.md#uppladdningens-tillfälliga-lagring) beskriver livslängd och lagringsgränser.

## Svar från Eneo

Alla anrop går genom en enda HTTP-klient (`backend/app/upstream.py`) som betjänar alla användare och bär servicenyckeln på varje anrop. Den är byggd för att ingenting ska läcka mellan användare eller växa utan gräns:

- **Inga cookies:** klienten lagrar och skickar inga, så en cookie som Eneo sätter för en användare följer inte med nästa.
- **Inga omdirigeringar:** en omdirigering från Eneo är ett fel, `502 upstream_redirect`.
- **Inget svar läses förbi en gräns:** längden räknas medan svaret kommer, och ett kodat svar avvisas.
- Loggarna innehåller aldrig en URL med query eller en token, eftersom en signerad fil-URL bär sin token i queryn.

## Filer ut ur Eneo

Eneo ger en kortlivad signerad URL per fil, och den är en bärartoken. Webbläsaren får den aldrig: BFF:en hämtar den med modulens credentials, kontrollerar svaret innan det sparas, skriver om värden till `ENEO_BACKEND_URL` och strömmar filen med `Range` intakt. Bara en typ som inte kan köra skript (ljud, video, PDF, vanliga bilder) öppnas inline; allt annat är en bilaga. En PDF kan visas i en ram på samma origin, och bara på begäran.

## Live-reläet

`/api/live/{flow_id}/{step_id}` vidarebefordrar live-text mellan webbläsaren och Eneo. Protokollet står i [Eneo-integration](eneo-integration.md#live-text-strömma). Det BFF:en själv avgör:

- **Gränser:** 128 KiB per meddelande från webbläsaren. Går en av sidorna inte att skriva till på 15 sekunder avslutar BFF:en sessionen.
- **Socketen följer sessionen:** den stängs med `1008` och skälet `session_ended` när sessionen tar slut, också när inget skickas (utloggning, utgång, en ny inloggning, en förnyelse som Eneo nekar).
- **Rätt användare:** sidans användare kontrolleras innan någon ticket begärs hos Eneo.
- **Ticketen** är en engångsticket som färdas som WebSocket-subprotokoll, valideras och når aldrig webbläsaren; anslutningen till Eneo följer ingen omdirigering.

## Statiska filer och säkerhetsheaders

`serve_web` i `backend/app/web.py` serverar det byggda gränssnittet efter varje API-rutt. Mappens filer indexeras en gång vid start: `/assets/<namn>` får en cache på ett år, övriga filer och sidan själv omprövas, och en sökväg utan filändelse ger sidan så att routern i webbläsaren tar vid. En saknad fil och en okänd `/api/...`-sökväg är 404 med JSON, aldrig sidan. Organisationens märke skrivs av backenden in i sidans markör vid start, utan inline-skript.

Säkerhetsheadrarna står i `backend/app/security_headers.json`, den enda definitionen, och sätts på varje svar, API och filströmmar inräknade. En header som en rutt själv sätter vinner (till exempel den inline PDF:ens ramning). Mikrofonen är det enda en sida får be om (`Permissions-Policy`), och varje svar under `/api` får `Cache-Control: no-store` om det inte själv säger något annat.

CSP:n är försvar på djupet. Den stoppar injicerad inline-kod och händelsehanterare och begränsar XSS-vägar till ljudet i IndexedDB; den gör inte XSS omöjlig. Utdatakodning (React-textnoder, Astryx `Markdown`, som visar rå HTML som text) och BFF:ens kontroller är de primära skydden. Skript och stilar tillåter varken `'unsafe-inline'` eller `'unsafe-eval'`.

## Säkerhetsegenskaper

- Servicenyckel, modultoken, ticket och signerade URL:er når aldrig webbläsaren.
- Webbläsaren väljer varken credentials, headers eller Eneo-rutter: allt utom det uppräknade nekas.
- Mutationer och live-socketen kräver modulens egen `Origin` och att sidan är för sessionens användare.
- Inget läses utan gräns, varken request-bodys eller svar från Eneo.
- Eneos cookies och omdirigeringar når inte webbläsaren, och en hotfull sökväg är 404 och aldrig en fil.
- Fel konfiguration stoppar starten, och en accentfärg under 4,5:1 likaså.

Testerna som håller detta ligger i `backend/tests/`, en fil per ansvar.

## Kända begränsningar

- JSON-anropen läses hela i minnet, upp till `MAX_BODY_BYTES` per request.
- Sidans användare kontrolleras inte på en GET utan namn, och inte alls på GET av ljud och genererade filer ([skälet](auth-and-session.md#sidans-användare-i-en-gammal-flik)).
- BFF:en har ingen egen rate limiting; det är proxyns uppgift.
- Sessionslagret och cachen med signerade URL:er är process-lokala: en backendprocess, en replik.
