# Backend (BFF)

Syfte: Beskriva modulens FastAPI-backend: rutter, tillåtelselistan mot Eneo, gränser, uppladdningar och signerade filer, inställningar och säkerhetsegenskaper.

Läs detta när: Du ändrar något under `backend/`, lägger till en Eneo-rutt som webbläsaren ska nå, felsöker ett 4xx eller 5xx från modulen, eller behöver veta vilka inställningar backend läser.

Hör ihop med: [Arkitektur](architecture.md), [Inloggning och session](auth-and-session.md), [Eneo-integration](eneo-integration.md), [Drift](operations.md), [Beslut om proxyn](decisions/0005-deny-by-default-proxy-and-body-limits.md)

## Var saker finns

| Sökväg | Innehåll |
|---|---|
| `backend/app/main.py` | Appen, rutterna, den proxade Eneo-vägen och tillåtelselistan, uppladdningarna, filströmmarna, live-reläet. En `lifespan`-hook stänger HTTP-klienten vid nedstängning. |
| `backend/app/module_auth.py` | Inloggning, sessionslager, förnyelse, kontroll av session, origin och sidans användare. |
| `backend/app/limits.py` | Taket för request-body (en ren ASGI-middleware) och 413-svaret. |
| `backend/app/upstream.py` | Den enda HTTP-klienten mot Eneo och dess gränser för vad den läser. |
| `backend/app/config.py` | Alla inställningar och deras validering vid start. |
| `backend/app/accent.py` | Organisationens accentfärg: kontroll mot sidans ytor, härledd mörk färg, och stilmallen som serveras. Bara standardbibliotek. |
| `backend/tests/` | Enhetstester med `unittest`, en fil per ansvar. Gränsen mot Eneo och webbläsaren prövas mest i `test_boundary.py` och `test_body_limits.py`. |
| `backend/Dockerfile`, `backend/requirements*.txt` | Backend-imagen (tvåcontainerfilen) och beroenden, med exakta versioner. Produktionsimagen byggs av `Dockerfile` i repots rot. |

Kör testerna från `backend/`:

```bash
.venv/bin/python -m unittest discover -s tests
```

`backend/.venv` skapas av devcontainern (`.devcontainer/post-create.sh`) eller med `python -m venv .venv && .venv/bin/pip install -r requirements.txt`.

## Rutter

Alla rutter ligger under `/api`. "Session" betyder giltig modulsession (annars 401), "Origin" att `Origin` är `MODULE_PUBLIC_URL` (annars 403).

| Rutt | Metod | Session | Origin | Vad |
|---|---|---|---|---|
| `/api/healthz` | GET | nej | nej | `{"ok": true}`. Webbläsaren når den som `/health` via Next-rewriten. |
| `/api/branding` | GET | nej | nej | Organisationen som visas i sidhuvudet. |
| `/api/branding/logo/{light\|dark}` | GET | nej | nej | Organisationens logotyp, 404 om ingen är konfigurerad. |
| `/api/branding/theme.css` | GET | nej | nej | Accentfärgens stilmall; en tom kommentar utan `ORGANIZATION_ACCENT`. Se [Branding](#branding). |
| `/api/auth/login` | GET | nej | nej | Startar Eneo SSO. Frågeparametrar: `next`, `renew`. Svarar bara på GET: ingen kod loggar in någon (POST ger 405). |
| `/api/auth/callback` | GET | nej | nej | Tar emot ticket och state från Eneo. |
| `/api/auth/logout` | POST | nej | ja | Tar bort sessionen. |
| `/api/auth/status` | GET | nej | nej | Inloggad eller inte, användare, `session_ends_in`, `refresh_in`. |
| `/api/eneo/flows/{flow_id}/files` | POST | ja | ja | Uppladdning, se [Uppladdningar](#uppladdningar). Med och utan avslutande snedstreck. |
| `/api/eneo/flows/{flow_id}/steps/{step_id}/runtime-files` | POST | ja | ja | Uppladdning till flödets ljudsteg. |
| `/api/eneo/flows/{flow_id}/template-files` | POST | ja | ja | Uppladdning av mallfil. |
| `/api/eneo/flows/{flow_id}/runs/{run_id}/input-files/{file_id}/audio` | GET | ja | nej | Strömmar körningens indatafil (ljud) med Range. |
| `/api/eneo/flows/{flow_id}/runs/{run_id}/artifacts/{file_id}/content` | GET | ja | nej | Strömmar en genererad fil. `?disposition=inline` ger inline bara för PDF. |
| `/api/eneo/{path}` | GET, POST, PATCH | ja | ja | Allt annat mot Eneo, bara det [tillåtelselistan](#tillåtelselistan-för-eneo-anrop) räknar upp. |
| `/api/live/{flow_id}/{step_id}` | WebSocket | ja | ja | Live-relä, se [Live-reläet](#live-reläet). |

- Specifika rutter registreras före den allmänna `/api/eneo/{path}`.
- Allt som ändrar något under `/api/eneo/` (uppladdningarna inräknade) och live-socketen kräver dessutom att sidan namnger sessionens användare; en GET under `/api/eneo/` får sakna namn, och GET av ljud och genererade filer kontrollerar inte alls. Se [Sidans användare](auth-and-session.md#sidans-användare-i-en-gammal-flik).
- Varje HTTP-rutt har ett tak för request-body, se [Gränser](#gränser).

## Tillåtelselistan för Eneo-anrop

Webbläsarens `/api/eneo/<sökväg>` blir `{ENEO_BACKEND_URL}/api/v1/<sökväg>`. Allt som inte räknas upp här får `403 Eneo resource is not exposed`. Sökvägarna är relativa till `/api/v1/`; `{x}` matchar ett enda segment.

| Metod | Sökväg |
|---|---|
| GET | `flows/` |
| GET | `flows/{flow}/published/`, `flows/{flow}/run-contract/`, `flows/{flow}/graph/` |
| GET, POST | `flows/{flow}/runs/` |
| GET | `flows/{flow}/runs/{run}/` och `flows/{flow}/runs/{run}/status/` |
| GET | `flows/{flow}/runs/{run}/steps/` |
| GET | `flows/{flow}/runs/{run}/steps/{step}/transcript-words/` |
| GET | `flows/{flow}/runs/{run}/transcript-corrections/` |
| GET | `flows/{flow}/runs/{run}/steps/{step}/attempts/{attempt}/transcript-source/` |
| PATCH | `flows/{flow}/runs/{run}/steps/{step}/transcript-corrections/` |
| POST | `flows/{flow}/runs/{run}/cancel/`, `.../redispatch/`, `.../retry/` |
| POST | `flows/{flow}/runs/{run}/steps/{step}/transcript-regenerations/` |
| POST | `flows/{flow}/runs/{run}/steps/{step}/rerun/` |
| GET | `flows/{flow}/runs/{run}/evidence/` och `.../evidence/export` |
| GET | `flows/{flow}/runs/{run}/review-checkpoints/active/` |
| PATCH | `flows/{flow}/runs/{run}/review-checkpoints/{checkpoint}/` |
| POST | `flows/{flow}/runs/{run}/review-checkpoints/{checkpoint}/approve/`, `.../reject/`, `.../resume/` |
| GET | `flows/{flow}/template-files/` |

Källan är `_PROXY_ROUTE_RULES` i `backend/app/main.py`; testerna är `backend/tests/test_eneo_proxy_auth.py`.

### Sökvägen

- En sökväg med `?`, `#`, ett kontrolltecken, ett bakstreck eller ett segment som efter avkodning är `.` eller `..` avvisas med 403 före matchningen (`_leaves_route`). Ett kodat `%2E%2E` matchar annars `[^/]+` och skulle kunna nå en annan Eneo-rutt.
- Sökvägen är avkodad en gång när den godkänns, så varje segment kodas om som det ett segment det är när URL:en till Eneo byggs (`_upstream_url`, den enda platsen där en utgående Eneo-URL görs, för proxyn, uppladdningarna och de signerade filerna). Ett `%2F` i ett id blir då ett id och ingen sökvägsgräns hos Eneo. En URL över 65 536 tecken får 414.
- Eneos rutter har avslutande snedstreck. `next dev` tar bort det, så en sökväg utan streck godtas om och bara om dess form med streck står på listan; BFF:en skickar alltid den kanoniska formen vidare.

### Headers

- **Request:** bara `Accept`, `Accept-Language`, `Content-Type`, `Idempotency-Key`, `If-Match` och `If-None-Match` från webbläsaren går vidare (`_FORWARDED_REQUEST_HEADERS`). Alla andra tas bort: `Cookie`, `Authorization`, `Origin`, `Referer`, `Host`, `Transfer-Encoding`, `Forwarded`, `X-Forwarded-For`, `X-Real-IP`, `X-Space-Id`, `X-Upload-Timeout-Seconds` och nyckelheadern, vad webbläsaren än skickar. Modulens credentials sätts ur sessionen. Ett vidarebefordrat headervärde med en byte över 127 ger 400, inte 500.
- **Svar:** Eneos svar skickas tillbaka utan `Content-Encoding`, `Transfer-Encoding`, `Connection`, `Keep-Alive`, `Content-Length`, `Set-Cookie` och `Location`. Eneos cookies är inte webbläsarens, och dess `Location` namnger Eneos egen värd.
- **Fel:** når BFF:en inte Eneo är svaret `502` med `{"error": "upstream_unreachable"}`. Ett svar som är för långt blir `502 upstream_too_large`, och en omdirigering från Eneo `502 upstream_redirect` (se [Svar från Eneo](#svar-från-eneo)).

### Lägga till en rutt

1. Lägg en rad i `_PROXY_ROUTE_RULES` med exakt de metoder och den sökväg som behövs, med avslutande snedstreck.
2. Lägg ett test i `backend/tests/test_eneo_proxy_auth.py`: rutten når Eneo, och en närliggande rutt (annan metod, extra segment) nekas.
3. Ladda upp och strömma filer med de särskilda rutterna nedan, inte med listan.

## Gränser

Värdena ligger i `backend/app/config.py`; var och en sätts där den gäller.

| Gräns | Standard | Gäller | Överskridet ger |
|---|---|---|---|
| `MAX_BODY_BYTES` | 10 MiB | Varje request-body utom uppladdningarna: JSON och allt annat, med eller utan session, även `POST /api/auth/login`. WebSocket berörs inte. | 413 med `max_body_bytes` i svaret. En ogiltig `Content-Length` ger 400. |
| `MAX_UPLOAD_BYTES` | 1 GiB | En `multipart/form-data` till de tre uppladdningsrutterna. | 413 med `max_upload_bytes` i svaret; 411 utan `Content-Length`. |
| `MAX_RESPONSE_BYTES` | 32 MiB | Ett enskilt svar från Eneo som modulen läser (proxyn och uppladdningens svar). En fil som strömmas till webbläsaren räknas inte. | `502 upstream_too_large` |
| små svar | 1 MiB | Svar som bär en token eller en URL (ticketväxling, sessionskontroll, förnyelse, signerad URL, live-ticket) och kroppen i ett misslyckat filsvar. | ett misslyckat anrop: ticketväxlingen avslutas utan session, en signerad URL ger `502 upstream_invalid`, en live-ticket händelsen `upstream_unreachable`; ett misslyckat filsvar behåller sin status men får en standardtext i stället för Eneos kropp |
| `UPLOAD_PROXY_TIMEOUT_SECONDS` | 1800 s | Hela vidarebefordran av en uppladdning, inte bara varje läsning. | `504 upstream_upload_timeout` |
| WebSocket-meddelande | 128 KiB | Webbläsarens live-socket, i alla startsätt. | stängning (`1009`) |
| logotyp | 1 MiB | `ORGANIZATION_LOGO`, bara SVG och PNG. | loggas, namnet visas |

Taket för request-body sitter i en ren ASGI-middleware, `BodyLimitMiddleware` i `backend/app/limits.py`, före allt annat:

- Den deklarerade längden över taket ger 413 direkt, och strömmen ger 413 så snart den passerar det. Antalet är de bytes som faktiskt kommer: en `Content-Length` som ljuger, eller en body i delar, kommer inte längre.
- Den kräver ingen session, så den gäller också innan en användare är inloggad, och den svarar innan FastAPI läser en JSON-body (en innehållstyp är klientens påstående, så ingen är undantagen).
- En `multipart/form-data` får deklarera upp till `MAX_UPLOAD_BYTES`, men taket höjs för just den requesten först efter att uppladdningsrutten kontrollerat session, origin och sidans användare (se [Uppladdningar](#uppladdningar)). En multipart till en annan rutt får inget större tak.
- 413-svaret har `Connection: close`, så att en klient som fortfarande skickar stannar. Eneo har egna gränser (ett flödes `max_file_size_bytes`, också 413); `max_body_bytes` eller `max_upload_bytes` i svaret visar att det är modulens.

## Uppladdningar

Ljud laddas upp genom särskilda rutter i stället för den allmänna proxyn, eftersom Eneos lastbalanserare svarade med `ReadError` när webbläsarens råa multipart-bytes vidarebefordrades. BFF:en tar emot filen och bygger om multipart-anropet med httpx (fältet heter `upload_file`). Rutterna är `files`, `steps/{step_id}/runtime-files` och `template-files` (se [Rutter](#rutter)), och Eneo nås på motsvarande `{ENEO_BACKEND_URL}/api/v1/flows/{flow_id}/...`.

Ordningen, i `_forward_upload` i `backend/app/main.py`:

1. Middlewaren nekar en deklarerad längd över `MAX_UPLOAD_BYTES` (413).
2. Rutten kör sina beroenden: session (401), origin (403) och sidans användare (409). Därför läses ingen byte av bodyn före dem: rutten har ingen `File(...)`-parameter, eftersom FastAPI annars läser en body innan beroenden körs.
3. Flödes- och steg-id får inte lämna rutten (403). `Content-Length` måste finnas (411) och vara högst `MAX_UPLOAD_BYTES` (413).
4. Bodyn måste vara exakt en filpart med namnet `upload_file`, utan något annat fält, och filnamn och innehållstyp får sakna kontrolltecken (400): en radbrytning skulle annars skrivas in i partens headers mot Eneo. Inget blir kvar om uppladdningen avbryts eller nekas.
5. Filen skickas vidare. `UPLOAD_PROXY_TIMEOUT_SECONDS` är en tidsgräns för hela vidarebefordran (att skicka filen och vänta på svaret), utöver httpx tidsgränser per operation (10 s för anslutning, 30 s för väntan på poolen). Webbläsaren kan be om en kortare tidsgräns med headern `X-Upload-Timeout-Seconds`; den klipps till mellan 60 s och inställningen och skickas aldrig vidare.

Svaren: `504 upstream_upload_timeout` när tidsgränsen går ut, `502 upstream_unreachable` när Eneo inte nås, `502 upstream_too_large` och `502 upstream_redirect` enligt [Svar från Eneo](#svar-från-eneo). I övrigt går Eneos status, body och innehållstyp rakt igenom.

Lämnar webbläsaren innan filen är hel skickas inget. Är filen hel fortsätter vidarebefordran även om webbläsaren går: att avbryta mitt i kunde lämna Eneo med en del av filen, vilket modulen varken kan veta eller ångra. Kostnaden är begränsad av `MAX_UPLOAD_BYTES` och tidsgränsen, och den tillfälliga filen stängs alltid.

Tester: `backend/tests/test_body_limits.py`, `backend/tests/test_upload_proxy.py`, och `UploadDeadlineTests` och `AbandonedUploadTests` i `backend/tests/test_boundary.py`.

### Next.js ligger före BFF:en

Next proxar `/api/*` till FastAPI och klonar då request-bodyn med ett standardtak på 10 MB; större bodies kapas tyst. `frontend/next.config.mjs` höjer taket med `experimental.proxyClientMaxBodySize` (2 GB), så att en fil upp till BFF:ens tak (1 GiB som standard) kommer fram: det är BFF:en som nekar en för stor uppladdning, med 413. Next håller den klonade bodyn i minnet under uppladdningen, så taket är samtidigt ett minnestak per upload i Next-processen. Next släpper dessutom ett anrop som varit tyst i 30 s; `experimental.proxyTimeout` är 31 minuter och ska hållas över `UPLOAD_PROXY_TIMEOUT_SECONDS` om den höjs.

Webbläsaren använder ingen hårdkodad timeout för stora ljudfiler. Klienten räknar upload-timeout från `runtime_upload_policy` i flödets kontrakt och håller uppladdningen vid liv så länge progress fortsätter.

## Svar från Eneo

Alla anrop till Eneo går genom en enda HTTP-klient (`make_client` i `backend/app/upstream.py`). Den betjänar alla användare och bär servicenyckeln på varje anrop, så den är byggd för att ingenting ska läcka mellan användare eller växa utan gräns:

- **Inga cookies:** klienten lagrar inga och skickar inga. En cookie som Eneo sätter på ett anrop för en användare skulle annars följa med nästa användares anrop.
- **Inga omdirigeringar:** klienten följer ingen. En omdirigering (301, 302, 303, 307, 308) från Eneo är ett fel, `502 upstream_redirect`, för proxyn, uppladdningen och de signerade filerna; ingen rutt i modulen förväntas omdirigera. 304 är ingen omdirigering: `If-None-Match` skickas vidare, så en villkorlig läsning kan få det.
- **Inget svar läses förbi en gräns:** `MAX_RESPONSE_BYTES`, eller 1 MiB för svar som bär en token eller en URL (se [Gränser](#gränser)). Längden räknas medan svaret kommer, och ett längre svar stängs: `UnboundedAnswer`, som blir `502 upstream_too_large`. En deklarerad `Content-Length` över gränsen avvisas innan en byte lästs.
- **Inget kodat svar:** modulen ber om `Accept-Encoding: identity` och avvisar ett kodat svar, eftersom några KB gzip kan avkodas till gigabyte och det som räknas ska vara det som hålls i minnet. Svar utan innehåll (HEAD, 1xx, 204, 304) bedöms inte efter längden de beskriver.
- **Strömmade filer** räknas inte: de går direkt till webbläsaren.

Tester: `UpstreamAnswerTests`, `CookieJarTests` och `RedirectFromEneoTests` i `backend/tests/test_boundary.py`.

## Filer ut ur Eneo

Eneo ger en kortlivad signerad URL per fil, och den URL:en är en bärartoken. Webbläsaren får den aldrig: CSP:n tillåter bara same-origin media och ramar. Diagram: [Uppladdning och signerade filer](architecture.md#uppladdning-och-signerade-filer).

- **Mint:** BFF:en begär URL:en med modulens credentials (`expires_in` 15 minuter). Svaret är högst 1 MiB och kontrolleras innan något sparas: ett JSON-objekt med en `url` som är `http` eller `https` med värd och som httpx kan skicka till, och ett `expires_at` som är ett ändligt tal (saknas det tas 15 minuter). Annars svarar modulen `502 upstream_invalid`, och inget cachas. En omdirigering på mintanropet är också ogiltig.
- **Cache:** URL:en cachas per session och fil, och förnyas 60 sekunder före slutet. Så skapar inte webbläsarens många Range-förfrågningar (och Eneos auditlogg) en ny URL var. En avvisad token (400 eller högre) eller en omdirigering tar den ur cachen.
- **Värd:** URL:en skrivs om till `ENEO_BACKEND_URL`: Eneo bygger den på sin publika adress, men modulens backend når Eneo på modulnätverket. Bara scheme och värd byts; sökväg och signerad query är orörda.
- **Headers:** av webbläsarens headers förs bara `Range`, `If-Range` och `Accept` vidare. Svaret behåller `Content-Type`, `Content-Length`, `Content-Range`, `Content-Disposition`, `Content-Encoding`, `Accept-Ranges`, `ETag` och `Last-Modified`, och får alltid `X-Content-Type-Options: nosniff` och `Cache-Control: private, no-store`.
- **Inline eller bilaga:** filerna serveras från modulens egen origin, där sidans data finns, och en indatafil kan vara vilken typ ett flöde tar emot. Bara en typ som inte kan köra skript öppnas inline: `audio/*`, `video/*`, `application/pdf`, `image/png`, `image/jpeg`, `image/gif` och `image/webp` (`_may_be_shown_inline`). Allt annat, en saknad typ inräknad, blir `Content-Disposition: attachment` med de parametrar Eneo skickade (filnamnet).
- **Genererade filer** (`artifacts/{file_id}/content`) behåller Eneos filnamn, saneras för headern (kontrolltecken, citattecken och snedstreck byts mot blanksteg, ASCII-reserv plus UTF-8-namn). Bara en PDF kan öppnas inline, och bara med `?disposition=inline`: då med `X-Frame-Options: SAMEORIGIN` och `Content-Security-Policy: frame-ancestors 'self'`, så att resultatsidan kan visa den i en ram på samma origin. Allt annat laddas ned som bilaga.
- **Fel:** ett misslyckat filsvar läses till högst 1 MiB och stängs; Eneos JSON-fel går igenom med sin status, och en längre kropp ersätts av en standardtext. Bryts felkroppen av blir det `502 upstream_unreachable`.

Tester: `backend/tests/test_audio_proxy.py`, `backend/tests/test_artifact_proxy.py`, och `SignedFileHeadersTests` och `MintAnswerTests` i `backend/tests/test_boundary.py`.

## Live-reläet

`/api/live/{flow_id}/{step_id}` är en WebSocket som vidarebefordrar live-text mellan webbläsaren och Eneo. Protokollet och fellägena står i [Eneo-integration](eneo-integration.md#live-text-strömma). Här gäller det som BFF:en själv avgör:

- **Gränser:** varje startsätt för backend (`python -m app.serve`) tar emot högst 128 KiB per WebSocket-meddelande, och ett större stänger anslutningen med `1009`. Uvicorns standardimplementation slutar läsa från en anslutning så snart ett meddelande ligger i kö och fortsätter först när appen har tagit emot det, så en anslutning buffrar ungefär ett meddelande på högst 128 KiB (`test_live_relay.py` låser detta). Går en av sidorna inte att skriva till på 15 sekunder avslutar BFF:en sessionen. Meddelanden från Eneo kan vara högst 8 MiB (`transcript.done` upprepar hela texten). Startsätten är `deploy/supervisord.conf` (produktionsimagen), `backend/Dockerfile` (tvåcontainerfilen) och utvecklingskommandot i [README](../README.md); `backend/tests/test_live_relay.py` kräver att alla tre har samma gränser och läser därför utvecklingskommandot direkt ur `README.md`.
- **Socketen följer sessionen.** Sessionen kontrolleras när socketen öppnas, men en socket lever lika länge som en inspelning, så den stängs med `1008` och skälet `session_ended` när sessionen tar slut, också när inget skickas: vid utloggning, utgång, en ny inloggning som ersätter sessionen och en förnyelse som Eneo nekar. En session som förnyas stängs inte vid sitt första slut utan vid det nya. Båda sockets stängs.
- **Rätt användare:** socketen kontrollerar sidans användare innan någon biljett begärs hos Eneo, se [Sidans användare](auth-and-session.md#sidans-användare-i-en-gammal-flik).
- **Biljetten och anslutningen till Eneo:** biljetten måste vara en HTTP-token (1 till 1 024 tecken), eftersom den färdas som WebSocket-subprotokoll, och `websocket_path` en enda sökväg på Eneos värd; allt annat skulle skicka biljetten någon annanstans. Anslutningen följer ingen omdirigering, eftersom biblioteket annars skickar användarens engångsbiljett vidare till vem svaret än namnger. En biljett eller sökväg som inte går att använda ger händelsen `upstream_unreachable` med `retryable: true`, och biljetten loggas aldrig.

Tester: `backend/tests/test_live_relay.py`, och `LiveSocketTests`, `LiveSessionEndTests` och `LiveExpectedUserTests` i `backend/tests/test_boundary.py`.

## Branding

`/api/branding` och logotyperna kräver ingen session, eftersom inloggningssidan visar organisationen innan det finns en. Logon serveras från samma origin eftersom sidans CSP bara tillåter egna bilder, med `X-Content-Type-Options: nosniff`, `Cache-Control: no-cache` och en egen `Content-Security-Policy` (`default-src 'none'; style-src 'unsafe-inline'; sandbox`) så att en SVG som öppnas för sig inte kan köra något i modulens origin. Svaret på `/api/branding` ger varje egen logga med dess storlek (`logo_sizes`, för ljus och mörk), läst vid start ur SVG:ns `viewBox` eller `width` och `height` eller ur PNG:ns huvud, så att sidan kan ge bilden bredd och höjd och sidhuvudet inte flyttar sig när filen kommer. En logga vars storlek inte går att läsa räknas som en logga som inte duger: den loggas en gång och namnet visas i stället. Samma svar skrivs in i sidans markör (`<meta name="eneo-branding">`). Inställningarna står i tabellen nedan; hur en annan organisation ställer in dem står i [Byt organisation](branding.md).

**Accentfärgen** (`backend/app/accent.py`) kontrolleras när backend startar: en färg som inte är `#RRGGBB`, eller som inte når 4,5:1 mot sidans ytor i båda lägena, stoppar start med ett enda svenskt felmeddelande som anger vad som mättes. Utan `ORGANIZATION_ACCENT_DARK` härleds den mörka färgen ur den ljusa. Kraven och felmeddelandena står i [Byt organisation](branding.md#accentfärgen), skälen i [beslut 0006](decisions/0006-white-label-branding.md).

`GET /api/branding/theme.css` formaterar bara en redan kontrollerad accent in i en fast mall, och är en tom kommentar när ingen accent är satt. Svaret har `Cache-Control: public, max-age=300`, en `ETag` (304 vid matchande `If-None-Match`) och `X-Content-Type-Options: nosniff`. Sidan länkar stilmallen i `<head>` (`frontend/index.html`): en vanlig same-origin-länk håller första målningen tills den är hämtad, så ingen bildruta visar den gamla färgen, och en strikt `style-src 'self'` släpper in den.

## Inställningar

Backend läser miljön en gång vid start (`load_settings` i `backend/app/config.py`); ett ogiltigt värde stoppar start med ett tydligt fel. Kontrollera listan mot koden med:

```bash
grep -ohE '"[A-Z][A-Z_]+"' backend/app/config.py | tr -d '"' | sort -u
```

| Variabel | Krävs | Standard | Regel och betydelse |
|---|---|---|---|
| `ENEO_BACKEND_URL` | ja | | Absolut http(s)-URL utan query eller fragment. Dit BFF:en når Eneos API; `http` är tillåtet, eftersom det är tjänstenätets adress. |
| `ENEO_PUBLIC_URL` | ja | | Absolut URL utan query eller fragment, `https`; `http` bara för `localhost`, `127.0.0.1` eller `[::1]`, annars stoppas starten. Eneos publika adress, dit webbläsaren skickas för inloggning. |
| `MODULE_PUBLIC_URL` | ja | | Samma regel som `ENEO_PUBLIC_URL`. Modulens publika adress. Ger callback-URL:en och den tillåtna `Origin`. |
| `MODULE_KEY` | ja | | Gemener i kebab-case (`[a-z0-9]+(-[a-z0-9]+)*`). Modulens nyckel i Eneo, i praktiken `speech-to-text`. |
| `ENEO_API_KEY` | ja | | Modulens servicenyckel (`sk_…`). |
| `ENEO_API_KEY_HEADER_NAME` | nej | `X-API-Key` | Giltigt HTTP-headernamn som inte är ett credential- eller ramhuvud som modulen sätter själv (`Authorization`, `Cookie`, `Content-Type` och de andra i `_RESERVED_HEADER_NAMES`). Ska vara samma som Eneos `API_KEY_HEADER_NAME`. |
| `SESSION_SECRET` | ja | | Minst 32 tecken. Signerar login-state. Sessionen i sig är opak. |
| `COOKIE_SECURE` | nej | `true` | `true`, `false`, `1`, `0`, `yes`, `no`, `on` eller `off`; annat stoppar start. `false` godtas bara när `MODULE_PUBLIC_URL` är `localhost`, `127.0.0.1` eller `[::1]`; annars stoppas starten. |
| `UPLOAD_PROXY_TIMEOUT_SECONDS` | nej | `1800` | Ett ändligt antal sekunder, över 0 och högst 86400. Tidsgräns för hela vidarebefordran av en uppladdning till Eneo, inte bara per läsning. |
| `MAX_BODY_BYTES` | nej | `10485760` (10 MiB) | Tak för varje request-body utom uppladdningar. Se [Gränser](#gränser). |
| `MAX_UPLOAD_BYTES` | nej | `1073741824` (1 GiB) | Tak för en uppladdad fil. Höj den om Eneos flöden tar emot större ljudfiler. |
| `MAX_RESPONSE_BYTES` | nej | `33554432` (32 MiB) | Mest som läses av ett enskilt svar från Eneo. Längre svar blir 502. |
| `SESSION_MAX_AGE_MINUTES` | nej | `480` | Heltal större än noll. Övre gräns för en inloggning; det tidigaste av detta och Eneos sessionstak gäller. |
| `SHOW_ORGANIZATION` | nej | `true` | Boolean som `COOKIE_SECURE`. `false` visar bara "Tal till text". |
| `ORGANIZATION_NAME` | nej | tomt | Högst 100 tecken. Tomt ger Sundsvalls kommun med dess medföljande logotyp. Är också logons alternativtext. |
| `ORGANIZATION_LOGO` | nej | tomt | Sökväg till en SVG- eller PNG-fil, högst 1 MiB. Kräver `ORGANIZATION_NAME`. |
| `ORGANIZATION_LOGO_DARK` | nej | tomt | Valfri logotyp för mörkt tema. Utan den används den vanliga. |
| `ORGANIZATION_ACCENT` | nej | tomt (temats `#004595`) | Accentfärgen som `#RRGGBB`. Måste nå 4,5:1 mot sidans ytor i ljust och mörkt läge, annars stoppas start. |
| `ORGANIZATION_ACCENT_DARK` | nej | härleds | Accentfärgen i mörkt läge, `#RRGGBB`. Kräver `ORGANIZATION_ACCENT`. Utelämnad härleds den ur den ljusa med samma nyans. |

De tre byte-gränserna är heltal från 1 till 2^40 (1 TiB); ett värde utanför det, eller ett tomt, stoppar start (`_positive_int`). Compose skickar de numeriska standardvärdena, och ett tomt värde i Compose blir standardvärdet.

Äldre exempelvärden som `MODULE_ID` och `TAL_TILL_TEXT_API_KEY` läses medvetet inte av imagen. Frontend har egna variabler, se [Drift](operations.md#miljövariabler).

## Säkerhetsegenskaper

Testfilerna ligger i `backend/tests/`; `test_boundary.py` är gränsen mot Eneo och webbläsaren, med klassnamn där det behövs.

| Egenskap | Hur den hålls | Test |
|---|---|---|
| Inga credentials i webbläsaren | Servicenyckel och modultoken stannar i backend, sessions-ID:t är opakt. | `test_module_auth.py`, `test_eneo_proxy_auth.py` |
| Webbläsaren kan inte välja credentials eller headers | Bara de uppräknade request-headrarna går vidare, credentials sätts ur sessionen, och nyckelheadern kan inte heta som ett credential- eller ramhuvud. | `test_eneo_proxy_auth.py`, `test_boundary.py` (`BrowserHeaderTests`, `ApiKeyHeaderNameTests`), `test_config.py` |
| Deny by default | Bara uppräknade metoder och sökvägar når Eneo. | `test_eneo_proxy_auth.py` |
| Ingen sökvägsförflyttning | `.`/`..`, kodade varianter, `?`, `#`, kontrolltecken och bakstreck avvisas före matchning, och varje segment kodas om på vägen ut så att ett `%2F` förblir ett id. | `test_eneo_proxy_auth.py`, `test_boundary.py` (`DoubleEncodingTests`, `UnsafePathTests`), `test_audio_proxy.py`, `test_artifact_proxy.py` |
| Same-origin för mutationer och WebSocket | `Origin` måste vara `MODULE_PUBLIC_URL`. Webbläsarens egen origin skickas aldrig till Eneo. | `test_eneo_proxy_auth.py`, `test_live_relay.py` |
| Rätt användare i en gammal flik | En sida som hör till en annan användare än sessionens, eller som inte namnger någon när den ändrar något, nekas med 409 `user_changed`, eller stängs med 1008, innan något når Eneo. | `test_boundary.py` (`ExpectedUserTests`, `LiveExpectedUserTests`) |
| Inloggningens state och återvändande | Slumpmässigt, signerat, förbrukas vid callbacken och jämförs som bytes (ett icke-ASCII-tecken ger inget 500); en förnyelse binds till samma användare och tenant; en inloggning återvänder bara till en sökväg på modulens egen origin. | `test_module_auth.py`, `test_boundary.py` (`CallbackStateTests`, `RedirectTests`) |
| Bara Eneo SSO, och osäkra inställningar bara lokalt | Ingen kod eller annan väg skapar en session än Eneos callback (en POST till `/api/auth/login` är 405). En publik adress är `https`, utom för `localhost`, `127.0.0.1` och `[::1]`, och en cookie utan `Secure` godtas bara där; annars stoppas starten. | `test_module_auth.py`, `test_config.py` |
| Sessionen avslutar det som hänger på den | En ny inloggning tar bort den gamla sessionen, och live-sockets stängs med 1008 `session_ended` när sessionen tar slut. | `test_boundary.py` (`LiveSessionEndTests`) |
| Tak för request-body | 413 över `MAX_BODY_BYTES` utan session, uppladdningar läses först efter sessionskontrollen och nekas med 411, 413 eller 400. | `test_body_limits.py`, `test_config.py`, `test_deployment_compose.py` |
| Begränsade svar från Eneo | Inget svar läses förbi sin gräns, och ett kodat svar avvisas. | `test_boundary.py` (`UpstreamAnswerTests`) |
| Eneos cookies och omdirigeringar når inte webbläsaren | Klienten lagrar och skickar inga cookies, `Set-Cookie` och `Location` skickas inte vidare och en omdirigering är 502. | `test_boundary.py` (`CookieJarTests`, `RedirectFromEneoTests`) |
| Signerade filer | Webbläsaren kan inte själv skapa en signerad URL; svaret på mintanropet kontrolleras innan det cachas; bara typer som inte kan köra skript öppnas inline och allt skickas med `nosniff`; filnamn kan inte bryta sig ur headern; bara en PDF kan visas i en ram. | `test_artifact_proxy.py`, `test_audio_proxy.py`, `test_boundary.py` (`MintAnswerTests`, `SignedFileHeadersTests`) |
| Uppladdningar | En tidsgräns för hela vidarebefordran, och en fil som blivit hel skickas klart även om webbläsaren går. | `test_upload_proxy.py`, `test_boundary.py` (`UploadDeadlineTests`, `AbandonedUploadTests`) |
| Begränsade WebSocket-ramar | 128 KiB per meddelande i alla startsätt, och en anslutning buffrar ett meddelande eller två eftersom uvicorn slutar läsa när ett ligger i kö; 15 s skrivtidsgräns. | `test_live_relay.py` |
| Biljetten stannar hos BFF:en | Live-biljetten valideras som HTTP-token, anslutningen till Eneo följer ingen omdirigering, och biljetten når aldrig webbläsaren. | `test_boundary.py` (`LiveSocketTests`), `test_live_relay.py` |
| Inga hemligheter i loggar | Ett svar som inte klarar valideringen loggas utan undantaget, eftersom ett valideringsfel citerar det det nekade, och det är en åtkomsttoken (ticketväxling, sessionskontroll, förnyelse). | `test_boundary.py` (`SecretsInLogsTests`) |
| Giltig konfiguration | Se tabellen ovan: fel stoppar start. | `test_config.py` |
| Logotyper utan körbart innehåll | Bara SVG och PNG, kontrollerade på namn och innehåll, isolerade med en egen CSP. | `test_config.py`, `test_branding.py` |
| Läsbar accentfärg | Bara `#RRGGBB` godtas, accenten måste nå 4,5:1 i båda lägena, och stilmallen formateras bara ur en kontrollerad färg. | `test_accent.py`, `test_config.py`, `test_branding.py` |
| Klienten stängs vid nedstängning | `lifespan`-hooken stänger den delade HTTP-klienten. | `test_lifespan.py` |

## Kända begränsningar

- JSON-anropen läses hela i minnet, upp till `MAX_BODY_BYTES` (10 MiB som standard) per request.
- Sidans användare kontrolleras inte på en GET utan namn, och inte alls på GET av ljud och genererade filer: ett `<audio src>` och en PDF-ram kan inte sätta headers, och Eneo auktoriserar själv körningen. Frontend skickar ingen tenant. Se [Sidans användare](auth-and-session.md#sidans-användare-i-en-gammal-flik).
- BFF:en har ingen egen rate limiting. Skydda publika testmiljöer i ingressen.
- Sessionslagret och cachen med signerade URL:er är process-lokala: en backendreplik.
