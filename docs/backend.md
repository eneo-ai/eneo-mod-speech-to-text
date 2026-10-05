# Backend (BFF)

Modulens backend är en FastAPI-app i en process. Den håller inloggningen, släpper bara igenom uppräknade anrop till Eneo, strömmar filer, relayar live-text och serverar det byggda gränssnittet.

## Var saker finns

| Sökväg | Innehåll |
|---|---|
| `backend/app/serve.py` | Starten: `python -m app.serve`. |
| `backend/app/main.py` | Appen, rutterna, den proxade Eneo-vägen och tillåtelselistan, uppladdningarna, filströmmarna, live-reläet. |
| `backend/app/web.py` | Säkerhetsheaders på varje svar och serveringen av det byggda gränssnittet. |
| `backend/app/security_headers.json` | Den enda definitionen av säkerhetsheadrarna. |
| `backend/app/module_auth.py` | Inloggning, sessionslager, förnyelse, kontroll av session, origin och sidans användare. |
| `backend/app/limits.py` | Taket för request-body, 413-svaret och WebSocket-gränsen. |
| `backend/app/upstream.py` | Den enda HTTP-klienten mot Eneo och dess gränser för vad den läser. |
| `backend/app/config.py` | Alla inställningar och deras validering vid start. |
| `backend/app/accent.py` | Organisationens accentfärg: kontroll mot sidans ytor, härledd mörk färg, stilmallen. |
| `backend/export_openapi.py`, `docs/api/openapi.json` | API-beskrivningen (OpenAPI), skriven ur appen med `python export_openapi.py` i `backend/`. |
| `backend/tests/` | `unittest`, en fil per ansvar. [Tester](quality-gates.md) |
| `backend/requirements.txt`, `backend/requirements.lock` | Direkta paket med exakta versioner, och alla paket med hashar. [Drift](operations.md#uppdatera-beroenden-och-fästa-versioner) |

## Starten

`python -m app.serve` är det enda sättet att starta backenden, i imagen och vid utveckling. Den fastställer det som körningen beror på:

- **En arbetsprocess.** Sessionslagret är processlokalt, så en andra process skulle skicka personer fel. Starten vägrar ett försök att ändra det. Kör aldrig `uvicorn` direkt: då gäller varken arbetsprocessen eller WebSocket-gränsen.
- Ingen accesslogg (callbackens URL bär en engångsticket) och inget `Server`-huvud.
- WebSocket-meddelanden från webbläsaren är högst 128 KiB (`WS_MAX_MESSAGE_BYTES` i `limits.py`). Eneos PCM-ramar är högst 64 KiB; en större ram stänger socketen med 1009. Uvicorns standardimplementation läser ett meddelande i taget, så ingen köstorlek behövs.
- Ett stopp väntar högst 8 s på öppna strömmar (Docker avslutar en container efter 10 s, och en fil som strömmar tar aldrig slut av sig själv).
- Port 3001 på alla gränssnitt.
- Utan `--api-only` kräver starten att `STATIC_DIR` pekar på en mapp med det byggda gränssnittets `index.html`; en driftsättning utan sida är en misslyckad start. `--api-only` är för utveckling mot Vite och för tester, och `--reload` startar om vid kodändringar.

## Rutter

Alla rutter ligger under `/api` utom `/health` och det byggda gränssnittet. "Session" betyder giltig modulsession (annars 401), "Origin" att `Origin` är `MODULE_PUBLIC_URL` (annars 403).

| Rutt | Metod | Session | Origin | Vad |
|---|---|---|---|---|
| `/health`, `/api/healthz` | GET, HEAD | nej | nej | `{"ok": true}`. Riktiga rutter: ett trasigt bygge av gränssnittet kan inte svara hälsokontrollen med en sida. |
| `/api/branding` | GET | nej | nej | Organisationen som visas i sidhuvudet, med varje logotyps proportioner så att sidan reserverar plats. Ingen session: inloggningssidan visar organisationen före inloggningen. |
| `/api/branding/logo/{variant}` | GET | nej | nej | Organisationens logotyp, `variant` är `light` eller `dark`; 404 om ingen är konfigurerad. Från modulens egen origin, med `nosniff`, `no-cache` och en egen `Content-Security-Policy` (`default-src 'none'; style-src 'unsafe-inline'; sandbox`) så att en SVG som öppnas för sig inte kör något. |
| `/api/branding/theme.css` | GET | nej | nej | Accentfärgens stilmall, bara en redan kontrollerad accent i en fast mall; en tom kommentar utan `ORGANIZATION_ACCENT`. `public, max-age=300`, `ETag` (304 vid matchande `If-None-Match`). |
| `/api/auth/login` | GET | nej | nej | Startar inloggningen mot Eneo. Frågeparametrar: `next`, `renew`. |
| `/api/auth/callback` | GET | nej | nej | Tar emot ticket och state från Eneo. |
| `/api/auth/logout` | POST | nej | ja | Tar bort sessionen. |
| `/api/auth/status` | GET | nej | nej | `authenticated`, `user`, `session_ends_in`, `refresh_in` och `max_upload_bytes` (vad sidan får skicka i en uppladdning). |
| `/api/eneo/flows/{flow_id}/files/` | POST | ja | ja | Uppladdning, se [Uppladdningar](#uppladdningar). |
| `/api/eneo/flows/{flow_id}/steps/{step_id}/runtime-files/` | POST | ja | ja | Uppladdning till flödets ljudsteg. |
| `/api/eneo/flows/{flow_id}/runs/{run_id}/input-files/{file_id}/audio` | GET | ja | nej | Strömmar körningens indatafil med Range. |
| `/api/eneo/flows/{flow_id}/runs/{run_id}/artifacts/{file_id}/content` | GET | ja | nej | Strömmar en genererad fil. `?disposition=inline` ger inline bara för PDF. |
| `/api/eneo/{path}` | GET, POST, PATCH | ja | ja | Allt annat mot Eneo, bara det [tillåtelselistan](#tillåtelselistan-för-eneo-anrop) räknar upp. |
| `/api/live/{flow_id}/{step_id}` | WebSocket | ja | ja | Live-relä, se [Live-reläet](#live-reläet). |
| övriga GET och HEAD | | nej | nej | Det byggda gränssnittet, se [Statiska filer](#statiska-filer-och-säkerhetsheaders). |

- Rutterna matchas som de stavas: en variant med eller utan avslutande snedstreck som inte är en rutt är 404, aldrig en omdirigering. FastAPIs egna dokumentationsrutter (`/docs`, `/redoc`, `/openapi.json`) finns inte.
- Rutterna är beskrivna maskinläsbart i `docs/api/openapi.json`: vem som får anropa, uppladdningens fält `upload_file`, filströmmarna och felkoderna. Filen skrivs av `python export_openapi.py` i `backend/` och ett test misslyckas när den skiljer sig från appen. WebSocketen beskrivs bara här.
- Allt som ändrar något under `/api/eneo/` (uppladdningarna inräknade) och live-socketen kräver att sidan namnger sessionens användare; en GET under `/api/eneo/` får sakna namn, och GET av ljud och genererade filer kontrollerar inte alls. [Sidans användare](auth-and-session.md#sidans-användare-i-en-gammal-flik)
- Varje HTTP-rutt har ett tak för request-body, se [Gränser](#gränser).
- Märke och accent: [Byt organisation](branding.md). Accenten kontrolleras vid start (`backend/app/accent.py`): en färg som inte är `#RRGGBB`, eller som inte når 4,5:1 mot sidans ytor i båda lägena, stoppar starten. Skälen: [beslut 0006](decisions/0006-white-label-branding.md).

## Tillåtelselistan för Eneo-anrop

Webbläsarens `/api/eneo/<sökväg>` blir `{ENEO_BACKEND_URL}/api/v1/<sökväg>`. Allt som inte räknas upp här får `403 Eneo resource is not exposed`. Sökvägarna matchas som de stavas, med avslutande snedstreck; `{namn}` matchar ett enda segment. Bara det sidan anropar är med.

| Metod | Sökväg |
|---|---|
| GET | `/api/eneo/flows/` |
| GET | `/api/eneo/flows/{flow_id}/published/` |
| GET | `/api/eneo/flows/{flow_id}/run-contract/` |
| GET | `/api/eneo/flows/{flow_id}/graph/` |
| GET, POST | `/api/eneo/flows/{flow_id}/runs/` |
| GET | `/api/eneo/flows/{flow_id}/runs/{run_id}/` |
| GET | `/api/eneo/flows/{flow_id}/runs/{run_id}/status/` |
| GET | `/api/eneo/flows/{flow_id}/runs/{run_id}/steps/` |
| GET | `/api/eneo/flows/{flow_id}/runs/{run_id}/steps/{step_id}/transcript-words/` |
| GET | `/api/eneo/flows/{flow_id}/runs/{run_id}/transcript-corrections/` |
| GET | `/api/eneo/flows/{flow_id}/runs/{run_id}/steps/{step_id}/attempts/{attempt_id}/transcript-source/` |
| PATCH | `/api/eneo/flows/{flow_id}/runs/{run_id}/steps/{step_id}/transcript-corrections/` |
| POST | `/api/eneo/flows/{flow_id}/runs/{run_id}/cancel/` |
| POST | `/api/eneo/flows/{flow_id}/runs/{run_id}/retry/` |
| POST | `/api/eneo/flows/{flow_id}/runs/{run_id}/steps/{step_id}/transcript-regenerations/` |
| GET | `/api/eneo/flows/{flow_id}/runs/{run_id}/review-checkpoints/active/` |
| PATCH | `/api/eneo/flows/{flow_id}/runs/{run_id}/review-checkpoints/{checkpoint_id}/` |
| POST | `/api/eneo/flows/{flow_id}/runs/{run_id}/review-checkpoints/{checkpoint_id}/approve/` |
| POST | `/api/eneo/flows/{flow_id}/runs/{run_id}/review-checkpoints/{checkpoint_id}/reject/` |
| POST | `/api/eneo/flows/{flow_id}/runs/{run_id}/review-checkpoints/{checkpoint_id}/resume/` |

Källan är `PROXY_ROUTES` i `backend/app/main.py`. Ett test, `backend/tests/test_backend_page.py`, håller den här tabellen och tabellen över rutter ovan lika med appen.

**Sökvägen.** En sökväg med `?`, `#`, ett kontrolltecken, ett bakstreck eller ett segment som efter avkodning är `.` eller `..` avvisas med 403 före matchningen. Sökvägen är avkodad en gång när den godkänns, så varje segment kodas om som det ett segment det är när URL:en till Eneo byggs (`_upstream_url`, den enda platsen där en utgående Eneo-URL görs): ett `%2F` i ett id blir ett id och ingen sökvägsgräns hos Eneo. En URL över 65 536 tecken får 414.

**Request-headers.** Bara `Accept`, `Accept-Language`, `Content-Type`, `Idempotency-Key`, `If-Match` och `If-None-Match` från webbläsaren går vidare (`_FORWARDED_REQUEST_HEADERS`). Allt annat tas bort, vad webbläsaren än skickar: `Cookie`, `Authorization`, `Origin`, `Referer`, `Host`, `Transfer-Encoding`, `Forwarded`, `X-Forwarded-For`, `X-Real-IP`, nyckelheadern och internhuvuden. Modulens credentials sätts ur sessionen. Ett vidarebefordrat headervärde med en byte över 127 ger 400.

**Svars-headers.** Eneos svar skickas tillbaka utan `Content-Encoding`, `Transfer-Encoding`, `Connection`, `Keep-Alive`, `Content-Length`, `Set-Cookie`, `Location` och utan Eneos `Content-Security-Policy`, `X-Frame-Options`, `Permissions-Policy`, `Referrer-Policy` och `Cache-Control`: modulens säkerhetsheaders och dess cachepolicy (inget lagras under `/api`) är inte Eneos att ersätta. Ett JSON-svar på minst 1 KiB komprimeras med gzip för en klient som tar emot det (inte en fil som strömmas, inte ett svar på en Range-förfrågan, inte ett som redan är kodat).

**Fel.** Når BFF:en inte Eneo är svaret `502` med `{"error": "upstream_unreachable"}`; se [Svar från Eneo](#svar-från-eneo) för `upstream_too_large` och `upstream_redirect`.

**Lägga till en rutt.** Lägg en rad i `PROXY_ROUTES` med exakt de metoder och den sökväg som behövs, med avslutande snedstreck och ett eget namn för varje id, en rad i tabellen ovan och en text i `ENEO_SUMMARIES` i `backend/export_openapi.py`, och kör `python export_openapi.py` i `backend/`. Lägg ett test i `backend/tests/test_eneo_proxy_auth.py`: rutten når Eneo, och en närliggande rutt (annan metod, extra segment, varianten utan snedstreck) nekas. Filer laddas upp och strömmas med de särskilda rutterna, inte med listan. En header en ny rutt behöver läggs i `_FORWARDED_REQUEST_HEADERS`.

## Gränser

Värdena (standard och regler) står i [Drift](operations.md#miljövariabler). Här står vad varje gräns gäller och vad som svaras.

| Gräns | Gäller | Överskridet ger |
|---|---|---|
| `MAX_BODY_BYTES` | Varje request-body utom uppladdningarna: JSON och allt annat, med eller utan session, även inloggningens. WebSocket berörs inte. | 413 med `max_body_bytes` i svaret. En ogiltig `Content-Length` ger 400. |
| `MAX_UPLOAD_BYTES` | En `multipart/form-data` till de två uppladdningsrutterna, hela request-bodyn inräknad. | 413 med `max_upload_bytes` i svaret; 411 utan `Content-Length`. |
| `MAX_RESPONSE_BYTES` | Ett enskilt svar från Eneo som modulen läser (proxyn och uppladdningens svar). En fil som strömmas räknas inte. | `502 upstream_too_large` |
| små svar, 1 MiB | Svar som bär en token eller en URL (ticketväxling, sessionskontroll, förnyelse, signerad URL, live-ticket) och kroppen i ett misslyckat filsvar. | Ett misslyckat anrop: ticketväxlingen avslutas utan session, en signerad URL ger `502 upstream_invalid`, en live-ticket händelsen `upstream_unreachable`; ett misslyckat filsvar behåller sin status men får en standardtext i stället för Eneos kropp. |
| `UPLOAD_PROXY_TIMEOUT_SECONDS` | Hela vidarebefordran av en uppladdning, inte bara varje läsning. | `504 upstream_upload_timeout` |
| WebSocket-meddelande, 128 KiB | Webbläsarens live-socket. | stängning med 1009 |
| logotyp, 1 MiB | `ORGANIZATION_LOGO`, bara SVG och PNG. | loggas, namnet visas |

Taket för request-body sitter i en ren ASGI-middleware, `BodyLimitMiddleware` i `backend/app/limits.py`, före allt annat:

- Den deklarerade längden över taket ger 413 direkt, och strömmen ger 413 så snart den passerar det. Antalet är de bytes som faktiskt kommer: en `Content-Length` som ljuger, eller en body i delar, kommer inte längre.
- Den kräver ingen session, och den svarar innan FastAPI läser en JSON-body (en innehållstyp är klientens påstående, så ingen är undantagen).
- En `multipart/form-data` får deklarera upp till `MAX_UPLOAD_BYTES`, men taket höjs för just den requesten först efter att uppladdningsrutten kontrollerat session, origin och sidans användare. En multipart till en annan rutt får inget större tak.
- 413-svaret har `Connection: close`, så att en klient som fortfarande skickar stannar. Eneo har egna gränser (ett flödes `max_file_size_bytes`, också 413); `max_body_bytes` eller `max_upload_bytes` i svaret visar att det är modulens.

## Uppladdningar

Ljud laddas upp genom särskilda rutter i stället för den allmänna proxyn, eftersom Eneos lastbalanserare svarade med `ReadError` när webbläsarens råa multipart-bytes vidarebefordrades. BFF:en tar emot filen, lägger den i en tillfällig fil (disk, inte minne: [Drift](operations.md#uppladdningens-tillfälliga-lagring)) och bygger om multipart-anropet med httpx (fältet heter `upload_file`). Ordningen, i `_forward_upload` i `backend/app/main.py`:

1. Middlewaren nekar en deklarerad längd över `MAX_UPLOAD_BYTES` (413).
2. Rutten kör sina beroenden: session (401), origin (403) och sidans användare (409). Ingen byte av bodyn läses före dem: rutten har ingen `File(...)`-parameter, eftersom FastAPI annars läser en body innan beroenden körs.
3. Flödes- och steg-id får inte lämna rutten (403). `Content-Length` måste finnas (411) och vara högst `MAX_UPLOAD_BYTES` (413).
4. Bodyn måste vara exakt en filpart med namnet `upload_file`, utan något annat fält, och filnamn och innehållstyp får sakna kontrolltecken (400): en radbrytning skulle annars skrivas in i partens headers mot Eneo. Inget blir kvar om uppladdningen avbryts eller nekas.
5. Filen skickas vidare inom `UPLOAD_PROXY_TIMEOUT_SECONDS` för hela vidarebefordran (att skicka filen och vänta på svaret), utöver httpx tidsgränser per operation. Webbläsaren kan be om en kortare tidsgräns med `X-Upload-Timeout-Seconds`; den klipps till mellan 60 s och inställningen och skickas aldrig vidare.

Svaren: `504 upstream_upload_timeout`, `502 upstream_unreachable`, `502 upstream_too_large` och `502 upstream_redirect`; i övrigt går Eneos status, body och innehållstyp rakt igenom. Lämnar webbläsaren innan filen är hel skickas inget. Är filen hel fortsätter vidarebefordran även om webbläsaren går: att avbryta mitt i kunde lämna Eneo med en del av filen, vilket modulen varken kan veta eller ångra. Kostnaden är begränsad av `MAX_UPLOAD_BYTES` och tidsgränsen, och den tillfälliga filen stängs alltid.

Vad som står framför gränserna i en driftsättning (omvänd proxy): [Drift](operations.md#vad-som-står-framför-modulen).

## Svar från Eneo

Alla anrop till Eneo går genom en enda HTTP-klient (`make_client` i `backend/app/upstream.py`). Den betjänar alla användare och bär servicenyckeln på varje anrop, så den är byggd för att ingenting ska läcka mellan användare eller växa utan gräns:

- **Inga cookies:** klienten lagrar inga och skickar inga. En cookie som Eneo sätter på ett anrop för en användare skulle annars följa med nästa användares anrop.
- **Inga omdirigeringar:** klienten följer ingen. En omdirigering (301, 302, 303, 307, 308) från Eneo är ett fel, `502 upstream_redirect`, för proxyn, uppladdningen och de signerade filerna. 304 är ingen omdirigering: `If-None-Match` skickas vidare, så en villkorlig läsning kan få det.
- **Inget svar läses förbi en gräns:** `MAX_RESPONSE_BYTES`, eller 1 MiB för svar som bär en token eller en URL. Längden räknas medan svaret kommer, och ett längre svar stängs (`UnboundedAnswer`, som blir `502 upstream_too_large`). En deklarerad `Content-Length` över gränsen avvisas innan en byte lästs.
- **Inget kodat svar:** modulen ber om `Accept-Encoding: identity` och avvisar ett kodat svar, eftersom några KB gzip kan avkodas till gigabyte. Svar utan innehåll (HEAD, 1xx, 204, 304) bedöms inte efter längden de beskriver.
- **Strömmade filer** räknas inte: de går direkt till webbläsaren, och Eneos svar stängs hur svaret än slutar (helt, ett fel i kroppen eller att webbläsaren går).
- **Loggarna** innehåller aldrig en URL med query eller en token: `httpx` och `httpcore` loggar på WARNING, eftersom en signerad fil-URL bär sin token i queryn.

## Filer ut ur Eneo

Eneo ger en kortlivad signerad URL per fil, och den URL:en är en bärartoken. Webbläsaren får den aldrig: CSP:n tillåter bara same-origin media och ramar. Diagram: [Uppladdning och signerade filer](architecture.md#uppladdning-och-signerade-filer).

- **Mint:** BFF:en begär URL:en med modulens credentials (`expires_in` 15 minuter). Svaret är högst 1 MiB och kontrolleras innan något sparas: ett JSON-objekt med en `url` som är `http` eller `https` med värd och som httpx kan skicka till, och ett `expires_at` som är ett ändligt tal (saknas det tas 15 minuter). Annars svarar modulen `502 upstream_invalid`, och inget cachas. En omdirigering på mintanropet är också ogiltig.
- **Cache:** URL:en cachas per session och fil, och förnyas 60 sekunder före slutet, så att webbläsarens många Range-förfrågningar (och Eneos auditlogg) inte skapar en ny URL var. En avvisad token (400 eller högre) eller en omdirigering tar den ur cachen.
- **Värd:** URL:en skrivs om till `ENEO_BACKEND_URL`: Eneo bygger den på sin publika adress, men modulens backend når Eneo på modulnätverket. Bara scheme och värd byts.
- **Headers:** av webbläsarens headers förs bara `Range`, `If-Range` och `Accept` vidare. Svaret behåller `Content-Type`, `Content-Length`, `Content-Range`, `Content-Disposition`, `Content-Encoding`, `Accept-Ranges`, `ETag` och `Last-Modified`, och får alltid `X-Content-Type-Options: nosniff` och `Cache-Control: private, no-store`.
- **Inline eller bilaga:** filerna serveras från modulens egen origin, där sidans data finns, och en indatafil kan vara vilken typ ett flöde tar emot. Bara en typ som inte kan köra skript öppnas inline: `audio/*`, `video/*`, `application/pdf`, `image/png`, `image/jpeg`, `image/gif` och `image/webp` (`_may_be_shown_inline`). Allt annat, en saknad typ inräknad, blir `Content-Disposition: attachment` med de parametrar Eneo skickade.
- **Genererade filer** behåller Eneos filnamn, saneras för headern (kontrolltecken, citattecken och snedstreck byts mot blanksteg, ASCII-reserv plus UTF-8-namn). Bara en PDF kan öppnas inline, och bara med `?disposition=inline`: då med `X-Frame-Options: SAMEORIGIN` och `Content-Security-Policy: frame-ancestors 'self'`, så att resultatsidan kan visa den i en ram på samma origin.
- **Fel:** ett misslyckat filsvar läses till högst 1 MiB och stängs; Eneos JSON-fel går igenom med sin status. Bryts felkroppen av blir det `502 upstream_unreachable`.

## Live-reläet

`/api/live/{flow_id}/{step_id}` är en WebSocket som vidarebefordrar live-text mellan webbläsaren och Eneo. Protokollet står i [Eneo-integration](eneo-integration.md#live-text-strömma). Det BFF:en själv avgör:

- **Gränser:** 128 KiB per meddelande från webbläsaren (se [Starten](#starten)). Går en av sidorna inte att skriva till på 15 sekunder avslutar BFF:en sessionen. Meddelanden från Eneo kan vara högst 8 MiB (`transcript.done` upprepar hela texten).
- **Socketen följer sessionen.** Sessionen kontrolleras när socketen öppnas, men en socket lever lika länge som en inspelning, så den stängs med `1008` och skälet `session_ended` när sessionen tar slut, också när inget skickas: vid utloggning, utgång, en ny inloggning som ersätter sessionen och en förnyelse som Eneo nekar. En session som förnyas stängs inte vid sitt första slut utan vid det nya. Båda sockets stängs, och Eneos socket avbryts alltid.
- **Rätt användare:** socketen kontrollerar sidans användare innan någon biljett begärs hos Eneo ([Sidans användare](auth-and-session.md#sidans-användare-i-en-gammal-flik)).
- **Biljetten och anslutningen till Eneo:** biljetten måste vara en HTTP-token (1 till 1 024 tecken), eftersom den färdas som WebSocket-subprotokoll, och `websocket_path` en enda sökväg på Eneos värd; allt annat skulle skicka biljetten någon annanstans. Anslutningen följer ingen omdirigering. En biljett eller sökväg som inte går att använda ger händelsen `upstream_unreachable` med `retryable: true`, och biljetten loggas aldrig.

## Statiska filer och säkerhetsheaders

`serve_web` i `backend/app/web.py` registreras sist, efter varje API-rutt, och bara när `STATIC_DIR` är satt. Mappens filer indexeras en gång vid start (den är en del av imagen): en fil som tillkommer senare serveras inte, och en förfrågan gör ingen filsystemsuppslagning. Matchningen sker på den avkodade sökvägen, aldrig på queryn.

| Förfrågan | Svar |
|---|---|
| `/api` och `/api/...` som ingen rutt svarat på | `404` JSON (`{"detail": "Not Found"}`), aldrig en sida |
| `/assets/<namn>` | filen, `Cache-Control: public, max-age=31536000, immutable`; saknas den, 404 JSON |
| en fil med ändelse i roten (`live-pcm-worklet.js`, `brand/...svg`) | filen, `Cache-Control: no-cache` med `ETag` (en omprövning är 304); saknas den, 404 JSON |
| en sökväg vars sista segment saknar punkt, och `/index.html` | sidan (`index.html`): 200, `no-cache`, `ETag` |
| `/<något>.br`, `/<något>.gz` | 404: förkomprimerade filer serveras bara genom förhandling |
| en sökväg med NUL eller annat styrtecken, bakstreck, ett punktsegment eller som lämnar mappen | 404, aldrig en fil och aldrig 500 |
| `Accept-Encoding` med `br` eller `gzip`, och en `.br`- eller `.gz`-fil bredvid | den filen med `Content-Encoding` och `Vary: Accept-Encoding`, originalets `Content-Type`; en Range ignoreras |

- **Organisationen i sidan.** Sidan har en tom markör, `<meta name="eneo-branding" content="">`. Backenden skriver svaret från `/api/branding` i den en gång vid start, så att organisationens märke finns i första bildrutan utan ett anrop och utan inline-skript. En sida med inte exakt en markör stoppar starten.
- **Säkerhetsheadrarna** (`backend/app/security_headers.json`, en middleware i `web.py`) sätts på varje svar, API, filströmmar, omdirigeringar, 304 och fel inräknade, med `setdefault`: en header som en rutt själv sätter vinner (den inline PDF:ens ramning, SVG-logons sandlåde-CSP, signerade filers `nosniff` och disposition). Varje svar under `/api` får dessutom `Cache-Control: no-store` om det inte själv säger något om cachelagring.

| Header | Värde |
|---|---|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'` |
| `Referrer-Policy` | `no-referrer` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Permissions-Policy` | allt avstängt utom `microphone=(self)`: kamera, plats, skärminspelning, USB, serie, HID, Bluetooth, betalning och MIDI |

CSP:n är försvar på djupet. Den stoppar injicerad inline-kod och händelsehanterare och begränsar XSS-vägar till ljudet i IndexedDB; den gör inte XSS omöjlig. Utdatakodning (React-textnoder, `react-markdown` utan rå HTML) och BFF:ens kontroller är de primära skydden. Skript och stilar tillåter varken `'unsafe-inline'` eller `'unsafe-eval'`, någonstans. `blob:` och `data:` behövs för förhandslyssning på inspelningen.

## Säkerhetsegenskaper

`test_boundary.py` är gränsen mot Eneo och webbläsaren, med klassnamn där det behövs.

| Egenskap | Hur den hålls | Test |
|---|---|---|
| Inga credentials i webbläsaren | Servicenyckel och modultoken stannar i backend, sessions-ID:t är opakt. | `test_module_auth.py`, `test_eneo_proxy_auth.py` |
| Webbläsaren kan inte välja credentials eller headers | Bara de uppräknade request-headrarna går vidare, credentials sätts ur sessionen, och nyckelheadern kan inte heta som ett credential- eller ramhuvud. | `test_eneo_proxy_auth.py`, `test_boundary.py` (`BrowserHeaderTests`, `ApiKeyHeaderNameTests`), `test_config.py` |
| Deny by default | Bara uppräknade metoder och sökvägar når Eneo; varianten utan snedstreck är inte en rutt. | `test_eneo_proxy_auth.py`, `test_slashes.py` |
| Ingen sökvägsförflyttning | `.`/`..`, kodade varianter, `?`, `#`, kontrolltecken och bakstreck avvisas före matchning, och varje segment kodas om på vägen ut. | `test_eneo_proxy_auth.py`, `test_boundary.py` (`DoubleEncodingTests`, `UnsafePathTests`), `test_audio_proxy.py`, `test_artifact_proxy.py` |
| Same-origin för mutationer och WebSocket | `Origin` måste vara `MODULE_PUBLIC_URL`. Webbläsarens egen origin skickas aldrig till Eneo. | `test_eneo_proxy_auth.py`, `test_live_relay.py` |
| Rätt användare i en gammal flik | En sida för en annan användare än sessionens, eller utan namn när den ändrar något, nekas med 409 `user_changed`, eller stängs med 1008, innan något når Eneo. | `test_boundary.py` (`ExpectedUserTests`, `LiveExpectedUserTests`) |
| Inloggningens state och återvändande | Slumpmässigt, signerat, förbrukas vid callbacken och jämförs som bytes; en förnyelse binds till samma användare och tenant; inloggningen återvänder bara till en sökväg på modulens egen origin. | `test_module_auth.py`, `test_boundary.py` (`CallbackStateTests`, `RedirectTests`) |
| Sessionen avslutar det som hänger på den | En ny inloggning tar bort den gamla sessionen, och live-sockets stängs med 1008 `session_ended` när sessionen tar slut. | `test_boundary.py` (`LiveSessionEndTests`) |
| Tak för request-body | 413 över `MAX_BODY_BYTES` utan session, uppladdningar läses först efter sessionskontrollen och nekas med 411, 413 eller 400. | `test_body_limits.py`, `test_config.py` |
| Begränsade svar från Eneo | Inget svar läses förbi sin gräns, och ett kodat svar avvisas. | `test_boundary.py` (`UpstreamAnswerTests`) |
| Eneos cookies och omdirigeringar når inte webbläsaren | Klienten lagrar och skickar inga cookies, `Set-Cookie` och `Location` skickas inte vidare och en omdirigering är 502. | `test_boundary.py` (`CookieJarTests`, `RedirectFromEneoTests`) |
| Säkerhetsheaders på varje svar | En definition, `setdefault`, ett fel och en ström inräknade; Eneos egna säkerhets- och cacheheaders ersätter dem inte. | `test_web.py` (`SecurityHeadersTests`, `EndpointHeadersWinTests`, `ProxiedAnswerTests`) |
| Aldrig en sida för en saknad fil eller ett okänt API | Se [Statiska filer](#statiska-filer-och-säkerhetsheaders); en hotfull sökväg är 404, aldrig 500. | `test_web.py` (`StaticServingTests`, `PrecompressedTests`, `BrandingMarkerTests`) |
| Signerade filer | Svaret på mintanropet kontrolleras innan det cachas; bara typer som inte kan köra skript öppnas inline och allt skickas med `nosniff`; filnamn kan inte bryta sig ur headern; bara en PDF kan visas i en ram. | `test_artifact_proxy.py`, `test_audio_proxy.py`, `test_boundary.py` (`MintAnswerTests`, `SignedFileHeadersTests`) |
| Uppladdningar | En tidsgräns för hela vidarebefordran, och en fil som blivit hel skickas klart även om webbläsaren går. | `test_upload_proxy.py`, `test_boundary.py` (`UploadDeadlineTests`, `AbandonedUploadTests`) |
| Begränsade WebSocket-ramar, en process | 128 KiB; en arbetsprocess; stopp inom 8 s; allt via `app.serve`. | `test_live_relay.py`, `test_serve.py` |
| Biljetten stannar hos BFF:en | Live-biljetten valideras som HTTP-token, anslutningen till Eneo följer ingen omdirigering, och biljetten når aldrig webbläsaren. | `test_boundary.py` (`LiveSocketTests`), `test_live_relay.py` |
| Inga hemligheter i loggar | Ett svar som inte klarar valideringen loggas utan undantaget, och en signerad URL eller token loggas aldrig. | `test_boundary.py` (`SecretsInLogsTests`), `test_logs.py` |
| Giltig konfiguration | Fel stoppar starten. | `test_config.py` |
| Läsbar accentfärg, logotyper utan körbart innehåll | `#RRGGBB` och 4,5:1; bara SVG och PNG, kontrollerade på namn och innehåll. | `test_accent.py`, `test_config.py`, `test_branding.py` |
| Fastlåsta beroenden | Imagen installerar låsfilen med hashar, och låsfilen följer `requirements.txt`. | `test_dependency_lock.py` |

## Kända begränsningar

- JSON-anropen läses hela i minnet, upp till `MAX_BODY_BYTES` per request.
- Sidans användare kontrolleras inte på en GET utan namn, och inte alls på GET av ljud och genererade filer ([skälet](auth-and-session.md#sidans-användare-i-en-gammal-flik)).
- BFF:en har ingen egen rate limiting; det är ingressens uppgift.
- Sessionslagret och cachen med signerade URL:er är process-lokala: en backendprocess, en replik.
