# Backend (BFF)

Syfte: Beskriva modulens FastAPI-backend: rutter, tillåtelselistan mot Eneo, uppladdningar och signerade filer, inställningar och säkerhetsegenskaper.

Läs detta när: Du ändrar något under `backend/`, lägger till en Eneo-rutt som webbläsaren ska nå, felsöker ett 403, 502 eller 504, eller behöver veta vilka inställningar backend läser.

Hör ihop med: [Arkitektur](architecture.md), [Inloggning och session](auth-and-session.md), [Eneo-integration](eneo-integration.md), [Drift](operations.md), [Beslut om proxyn](decisions/0005-deny-by-default-proxy-and-body-limits.md)

## Var saker finns

| Sökväg | Innehåll |
|---|---|
| `backend/app/main.py` | Appen, rutterna, den proxade Eneo-vägen och tillåtelselistan, uppladdningarna, filströmmarna, live-reläet. |
| `backend/app/module_auth.py` | Inloggning, sessionslager, förnyelse, kontroll av session och origin. |
| `backend/app/config.py` | Alla inställningar och deras validering vid start. |
| `backend/app/accent.py` | Organisationens accentfärg: kontroll mot sidans ytor, härledd mörk färg, och stilmallen som serveras. Bara standardbibliotek. |
| `backend/tests/` | Enhetstester med `unittest`, en fil per ansvar (auth, proxy, uppladdning, filer, live-relä, branding, config, compose). |
| `backend/Dockerfile`, `backend/requirements*.txt` | Backend-imagen (tvåcontainerfilen) och beroenden. Produktionsimagen byggs av `Dockerfile` i repots rot. |

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
| `/api/config` | GET | ja | nej | Flödeslistans omfång: `{"flow_list": {"space_id": ...}}` eller `null`. |
| `/api/branding` | GET | nej | nej | Organisationen som visas i sidhuvudet. |
| `/api/branding/logo/{light\|dark}` | GET | nej | nej | Organisationens logotyp, 404 om ingen är konfigurerad. |
| `/api/branding/theme.css` | GET | nej | nej | Accentfärgens stilmall; en tom kommentar utan `ORGANIZATION_ACCENT`. Se [Branding](#branding). |
| `/api/auth/login` | GET | nej | nej | Startar Eneo SSO. Frågeparametrar: `next`, `renew`. Bara `eneo_sso`. |
| `/api/auth/login` | POST | nej | ja | Åtkomstkodsinloggning. Bara `access_code`. |
| `/api/auth/callback` | GET | nej | nej | Tar emot ticket och state från Eneo. Bara `eneo_sso`. |
| `/api/auth/logout` | POST | nej | ja | Tar bort sessionen. |
| `/api/auth/status` | GET | nej | nej | Inloggad eller inte, läge, användare, `session_ends_in`, `refresh_in`. |
| `/api/eneo/flows/{flow_id}/files` | POST | ja | ja | Uppladdning, se [Uppladdningar](#uppladdningar). Med och utan avslutande snedstreck. |
| `/api/eneo/flows/{flow_id}/steps/{step_id}/runtime-files` | POST | ja | ja | Uppladdning till flödets ljudsteg. |
| `/api/eneo/flows/{flow_id}/template-files` | POST | ja | ja | Uppladdning av mallfil. |
| `/api/eneo/flows/{flow_id}/runs/{run_id}/input-files/{file_id}/audio` | GET | ja | nej | Strömmar körningens ljud med Range. |
| `/api/eneo/flows/{flow_id}/runs/{run_id}/artifacts/{file_id}/content` | GET | ja | nej | Strömmar en genererad fil. `?disposition=inline` ger inline bara för PDF. |
| `/api/eneo/{path}` | GET, POST, PATCH | ja | ja | Allt annat mot Eneo, bara det [tillåtelselistan](#tillåtelselistan-för-eneo-anrop) räknar upp. |
| `/api/live/{flow_id}/{step_id}` | WebSocket | ja | ja | Live-relä, se [Eneo-integration](eneo-integration.md#live-text-strömma). |

Specifika rutter registreras före den allmänna `/api/eneo/{path}`.

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
| POST | `flows/{flow}/template-files/{file}/signed-url/` |

Källan är `_PROXY_ROUTE_RULES` i `backend/app/main.py`; testerna är `backend/tests/test_eneo_proxy_auth.py`.

Regler som gäller före matchningen:

- En sökväg med `?`, `#` eller ett segment som efter avkodning är `.` eller `..` avvisas. Ett kodat `%2E%2E` matchar annars `[^/]+` och skulle kunna nå en annan Eneo-rutt (`_leaves_route`).
- Eneos rutter har avslutande snedstreck. `next dev` tar bort det, så en sökväg utan streck godtas om och bara om dess form med streck står på listan; BFF:en skickar alltid den kanoniska formen vidare, så att Eneo inte svarar med en redirect som proxyn inte följer.
- Webbläsarens `Authorization`, `Cookie`, nyckelheadern, `Origin`, `Referer`, `Host`, `Connection`, `Content-Length`, `Accept-Encoding`, `X-Space-Id` och `X-Upload-Timeout-Seconds` skickas inte vidare. Modulens credentials läggs på i stället.
- Svar från Eneo skickas tillbaka utan hop-by-hop-headers (`Content-Encoding`, `Transfer-Encoding`, `Connection`, `Keep-Alive`, `Content-Length`).
- Når BFF:en inte Eneo svarar den `502` med `{"error": "upstream_unreachable"}`.

### Lägga till en rutt

1. Lägg en rad i `_PROXY_ROUTE_RULES` med exakt de metoder och den sökväg som behövs, med avslutande snedstreck.
2. Lägg ett test i `backend/tests/test_eneo_proxy_auth.py`: rutten når Eneo, och en närliggande rutt (annan metod, extra segment) nekas.
3. Ladda upp och strömma filer med de särskilda rutterna nedan, inte med listan.

## Uppladdningar

Ljud laddas upp genom särskilda rutter i stället för den allmänna proxyn, eftersom Eneos lastbalanserare svarade med `ReadError` när webbläsarens råa multipart-bytes vidarebefordrades. BFF:en tar emot filen och bygger om multipart-anropet med httpx (fältet heter `upload_file`).

- Mål: `{ENEO_BACKEND_URL}/api/v1/flows/{flow_id}/files/`, `.../steps/{step_id}/runtime-files/` och `.../template-files/`.
- Timeout: `UPLOAD_PROXY_TIMEOUT_SECONDS` (standard 1800) för läsning och skrivning, 10 s för anslutning. Webbläsaren kan be om en kortare tidsgräns med headern `X-Upload-Timeout-Seconds`; den klipps till mellan 60 s och inställningen.
- `504` med `upstream_upload_timeout` när Eneo inte hunnit klart, `502` med `upstream_unreachable` när Eneo inte nås. I övrigt går Eneos status, body och innehållstyp rakt igenom.
- Flödes- och steg-id får inte innehålla `.`/`..`-segment eller `?` (`403`).

### Next.js ligger före BFF:en

Next proxar `/api/*` till FastAPI och klonar då request-bodyn med ett standardtak på 10 MB; större bodies kapas tyst. `frontend/next.config.mjs` höjer taket med `experimental.proxyClientMaxBodySize` (2 GB) så att ljudfiler upp till Eneos `max_file_size_bytes` passerar. Next håller den klonade bodyn i minnet under uppladdningen, så taket är samtidigt ett minnestak per upload i Next-processen. Next släpper dessutom ett anrop som varit tyst i 30 s; `experimental.proxyTimeout` är 31 minuter och ska hållas över `UPLOAD_PROXY_TIMEOUT_SECONDS` om den höjs.

Webbläsaren använder ingen hårdkodad timeout för stora ljudfiler. Klienten räknar upload-timeout från `runtime_upload_policy` i flödets kontrakt och håller uppladdningen vid liv så länge progress fortsätter.

## Filer ut ur Eneo

Eneo ger en kortlivad signerad URL per fil, och den URL:en är en bärartoken. Webbläsaren får den aldrig: CSP:n tillåter bara same-origin media och ramar. Diagram: [Uppladdning och signerade filer](architecture.md#uppladdning-och-signerade-filer).

- BFF:en begär URL:en med modulens credentials (`expires_in` 15 minuter), cachar den per session och fil, och förnyar den 60 sekunder före slutet. Så skapar inte webbläsarens många Range-förfrågningar (och Eneos auditlogg) en ny URL var.
- URL:en skrivs om till `ENEO_BACKEND_URL`: Eneo bygger den på sin publika adress, men modulens backend når Eneo på modulnätverket. Bara scheme och värd byts; sökväg och signerad query är orörda.
- Av webbläsarens headers förs bara `Range`, `If-Range` och `Accept` vidare. Svaret behåller `Content-Type`, `Content-Length`, `Content-Range`, `Content-Disposition`, `Content-Encoding`, `Accept-Ranges`, `ETag` och `Last-Modified`, och får `Cache-Control: private, no-store`.
- En avvisad token (status 400 eller högre) tas ur cachen; nästa anrop skapar en ny.
- Genererade filer behåller Eneos filnamn, saneras för headern (kontrolltecken, citattecken och snedstreck byts mot blanksteg, ASCII-reserv plus UTF-8-namn) och skickas med `X-Content-Type-Options: nosniff`. Bara en PDF öppnas inline, och då med `X-Frame-Options: SAMEORIGIN` och `Content-Security-Policy: frame-ancestors 'self'` så att resultatsidan kan visa den i en ram på samma origin. Allt annat laddas ned som bilaga.

Tester: `backend/tests/test_audio_proxy.py`, `backend/tests/test_artifact_proxy.py`.

## Live-reläet

`/api/live/{flow_id}/{step_id}` är en WebSocket som vidarebefordrar live-text mellan webbläsaren och Eneo. Protokollet och fellägena står i [Eneo-integration](eneo-integration.md#live-text-strömma). Här gäller bara gränserna:

- Varje startsätt för backend tar emot högst 128 KiB per WebSocket-meddelande och 16 meddelanden i kö (`--ws-max-size 131072 --ws-max-queue 16`), alltså högst 2 MiB per anslutning innan Eneo ser ramarna.
- Går en av sidorna inte att skriva till på 15 sekunder avslutar BFF:en sessionen.
- Meddelanden från Eneo kan vara högst 8 MiB (`transcript.done` upprepar hela texten).
- Startsätten är `deploy/supervisord.conf` (produktionsimagen), `backend/Dockerfile` (tvåcontainerfilen) och utvecklingskommandot i [README](../README.md). `backend/tests/test_live_relay.py` kräver att alla tre har samma gränser, och läser därför utvecklingskommandot direkt ur `README.md`.

## Branding

`/api/branding` och logotyperna kräver ingen session, eftersom inloggningssidan visar organisationen innan det finns en. Logon serveras från samma origin eftersom sidans CSP bara tillåter egna bilder, med `X-Content-Type-Options: nosniff`, `Cache-Control: no-cache` och en egen `Content-Security-Policy` (`default-src 'none'; style-src 'unsafe-inline'; sandbox`) så att en SVG som öppnas för sig inte kan köra något i modulens origin. Inställningarna står i tabellen nedan; hur en annan organisation ställer in dem står i [Byt organisation](branding.md).

**Accentfärgen** (`backend/app/accent.py`) kontrolleras när backend startar. Accenten är också textfärgen på länkar och ikoner och färgen på fokusramen, så den hålls till ett enda krav, 4,5:1 (WCAG-kontrast): texten på accenten (vit eller nästan svart, den som syns bäst), accenten mot sidans ytor i båda lägena och den sekundära texten på accentens ton. En färg som inte når det, eller som inte är `#RRGGBB`, stoppar start med ett enda svenskt felmeddelande som anger vad som mättes. Utan `ORGANIZATION_ACCENT_DARK` gör backend färgen ljusare tills kraven nås och behåller nyans och mättnad; går det inte, krävs en egen mörk färg.

`GET /api/branding/theme.css` formaterar bara en redan kontrollerad accent in i en fast mall, och är en tom kommentar när ingen accent är satt. Svaret har `Cache-Control: public, max-age=300`, en `ETag` (304 vid matchande `If-None-Match`) och `X-Content-Type-Options: nosniff`. Rotlayouten länkar stilmallen i `<head>` (`frontend/app/layout.tsx`): en vanlig same-origin-länk håller första målningen tills den är hämtad, så ingen bildruta visar den gamla färgen, och en strikt `style-src 'self'` släpper in den.

## Inställningar

Backend läser miljön en gång vid start (`load_settings` i `backend/app/config.py`); ett ogiltigt värde stoppar start med ett tydligt fel. Kontrollera listan mot koden med:

```bash
grep -ohE '"[A-Z][A-Z_]+"' backend/app/config.py | tr -d '"' | sort -u
```

| Variabel | Krävs | Standard | Regel och betydelse |
|---|---|---|---|
| `AUTH_MODE` | nej | `eneo_sso` | `eneo_sso` eller `access_code`. Annat stoppar start. |
| `ENEO_BACKEND_URL` | ja | | Absolut http(s)-URL utan query eller fragment. Dit BFF:en når Eneos API. |
| `ENEO_PUBLIC_URL` | i `eneo_sso` | | Samma URL-regel. Eneos publika adress, dit webbläsaren skickas för inloggning. Läses inte i `access_code`. |
| `MODULE_PUBLIC_URL` | ja | | Samma URL-regel. Modulens publika adress. Ger callback-URL:en och den tillåtna `Origin`. |
| `MODULE_KEY` | ja | | Gemener i kebab-case (`[a-z0-9]+(-[a-z0-9]+)*`). Modulens nyckel i Eneo, i praktiken `speech-to-text`. |
| `ENEO_API_KEY` | ja | | Modulens servicenyckel (`sk_…`). Krävs i båda lägena. |
| `ENEO_API_KEY_HEADER_NAME` | nej | `X-API-Key` | Giltigt HTTP-headernamn. Ska vara samma som Eneos `API_KEY_HEADER_NAME`. |
| `SESSION_SECRET` | ja | | Minst 32 tecken. Signerar login-state. Sessionen i sig är opak. |
| `APP_ACCESS_CODE` | i `access_code` | | 16–256 tecken. Får inte sättas i `eneo_sso`. |
| `COOKIE_SECURE` | nej | `true` | `true`, `false`, `1`, `0`, `yes`, `no`, `on` eller `off`; annat stoppar start. `false` bara för lokal `http://localhost`. |
| `DEMO_SPACE_ID` | i `access_code` för flödeslistan | | Modulnyckeln listar bara flöden i detta space. Utan den loggar backend ett fel vid start och sidan säger att flödena inte kan visas. Används inte i `eneo_sso`, där listan omfattar alla användarens spaces. |
| `UPLOAD_PROXY_TIMEOUT_SECONDS` | nej | `1800` | Större än noll. Tak för upload-vidarebefordran till Eneo. |
| `MAX_BODY_BYTES` | nej | `10485760` (10 MiB) | (på gång: `fix/backend-body-limits`, väntar på PR). Heltal större än noll; ett tomt värde nekas. Tak för varje request-body utom uppladdningar; större ger 413. Finns i `backend/app/config.py` och `backend/app/limits.py` på grenen, inte på main. |
| `MAX_UPLOAD_BYTES` | nej | `1073741824` (1 GiB) | (på gång: `fix/backend-body-limits`, väntar på PR). Samma regel. Tak för en uppladdad fil. |
| `SESSION_MAX_AGE_MINUTES` | nej | `480` | Heltal större än noll. Övre gräns för en inloggning; i `eneo_sso` gäller det tidigaste av detta och Eneos sessionstak. |
| `SHOW_ORGANIZATION` | nej | `true` | Boolean som `COOKIE_SECURE`. `false` visar bara "Tal till text". |
| `ORGANIZATION_NAME` | nej | tomt | Högst 100 tecken. Tomt ger Sundsvalls kommun med dess medföljande logotyp. Är också logons alternativtext. |
| `ORGANIZATION_LOGO` | nej | tomt | Sökväg till en SVG- eller PNG-fil, högst 1 MiB. Kräver `ORGANIZATION_NAME`. |
| `ORGANIZATION_LOGO_DARK` | nej | tomt | Valfri logotyp för mörkt tema. Utan den används den vanliga. |
| `ORGANIZATION_ACCENT` | nej | tomt (temats `#004595`) | Accentfärgen som `#RRGGBB`. Måste nå 4,5:1 mot sidans ytor i ljust och mörkt läge, annars stoppas start. |
| `ORGANIZATION_ACCENT_DARK` | nej | härleds | Accentfärgen i mörkt läge, `#RRGGBB`. Kräver `ORGANIZATION_ACCENT`. Utelämnad härleds den ur den ljusa med samma nyans. |

Raderna märkta "på gång" finns inte i `backend/app/config.py` på main; se [På gång](#på-gång-inte-på-main).

Äldre exempelvärden som `MODULE_ID` och `TAL_TILL_TEXT_API_KEY` läses medvetet inte av imagen. Frontend har egna variabler, se [Drift](operations.md#miljövariabler).

## Säkerhetsegenskaper

| Egenskap | Hur den hålls | Test |
|---|---|---|
| Inga credentials i webbläsaren | Servicenyckel och modultoken stannar i backend, sessions-ID:t är opakt. | `test_module_auth.py`, `test_eneo_proxy_auth.py` |
| Webbläsaren kan inte välja credentials | Dess `Authorization`, `Cookie` och nyckelheader tas bort och modulens läggs på. | `test_eneo_proxy_auth.py` |
| Deny by default | Bara uppräknade metoder och sökvägar når Eneo. | `test_eneo_proxy_auth.py` |
| Ingen sökvägsförflyttning | `.`/`..`, kodade varianter, `?` och `#` avvisas före matchning. | `test_eneo_proxy_auth.py`, `test_audio_proxy.py`, `test_artifact_proxy.py` |
| Same-origin för mutationer och WebSocket | `Origin` måste vara `MODULE_PUBLIC_URL`. Webbläsarens egen origin skickas aldrig till Eneo. | `test_eneo_proxy_auth.py`, `test_live_relay.py` |
| Inloggningens state | Slumpmässigt, signerat, förbrukas vid callbacken; en förnyelse binds till samma användare och tenant. | `test_module_auth.py` |
| Fel läge, fel session | En session från det andra läget godtas inte; rutter för det andra läget ger 404. | `test_module_auth.py` |
| Signerade filer | Webbläsaren kan inte själv skapa en signerad URL; filnamn kan inte bryta sig ur headern; bara PDF visas inline. | `test_artifact_proxy.py`, `test_audio_proxy.py` |
| Begränsade WebSocket-ramar | 128 KiB och 16 i kö i alla startsätt; 15 s skrivtidsgräns. | `test_live_relay.py` |
| Giltig konfiguration | Se tabellen ovan: fel stoppar start. | `test_config.py` |
| Logotyper utan körbart innehåll | Bara SVG och PNG, kontrollerade på namn och innehåll, isolerade med en egen CSP. | `test_config.py`, `test_branding.py` |
| Läsbar accentfärg | Bara `#RRGGBB` godtas, accenten måste nå 4,5:1 i båda lägena, och stilmallen formateras bara ur en kontrollerad färg. | `test_accent.py`, `test_config.py`, `test_branding.py` |

## På gång (inte på main)

Det här står i grenar som är pushade men ännu inte sammanslagna. Det beskriver grenarnas kod, inte main. När en gren är sammanslagen flyttas texten in i avsnitten ovan och märkningen tas bort.

### Tak för request-body (på gång: `fix/backend-body-limits`, väntar på PR)

En ren ASGI-middleware, `BodyLimitMiddleware` i `backend/app/limits.py`, håller gränserna för hela appen.

| Egenskap | Hur |
|---|---|
| Varje request-body har ett tak | `MAX_BODY_BYTES` (10 MiB). 413 direkt om den deklarerade längden är över taket, och 413 så snart strömmen passerar det. Gäller alla HTTP-rutter oavsett innehållstyp (en innehållstyp är klientens påstående), och därför också publika `POST /api/auth/login`. WebSocket berörs inte. |
| Ogiltig `Content-Length` | 400, innan någon rutt ser den. |
| Uppladdningar får vara större | En `multipart/form-data` får deklarera upp till `MAX_UPLOAD_BYTES` (1 GiB). Taket höjs för just den requesten först efter rutten kontrollerat session och origin och sina egna längdkontroller, och räknar de bytes som faktiskt kommer: en `Content-Length` som ljuger, eller en body i delar, kommer inte längre. |
| Uppladdningsrutterna läser bodyn efter sessionskontrollen | De tre rutterna (`files`, `steps/{step_id}/runtime-files`, `template-files`) använder `_forward_upload` i `backend/app/main.py` i stället för `File(...)`: FastAPI läser annars en body innan en rutts beroenden körs. |
| Svar på en dålig uppladdning | 411 utan `Content-Length` (webbläsare skickar alltid en), 413 över `MAX_UPLOAD_BYTES`, 400 om bodyn inte är exakt en filpart med namnet `upload_file` (inga andra fält), eller om filnamn eller innehållstyp har ett kontrolltecken (en radbrytning skulle skrivas in i partens headers mot Eneo). Inget blir kvar om uppladdningen avbryts eller nekas. |

Tester på grenen: `backend/tests/test_body_limits.py`, och rader i `backend/tests/test_config.py` och `backend/tests/test_deployment_compose.py` (Compose skickar numeriska standardvärden, och ett tomt värde i Compose blir standardvärdet). `docker-compose.yml` och `.env.example` på grenen har de två variablerna.

Samspel med Next: Nexts tak för en body genom rewriten är 2 GB (se [Next.js ligger före BFF:en](#nextjs-ligger-före-bffen)), och BFF:ens tak för en uppladdning blir då lägre: 1 GiB.

### Lifespan och beroenden (`fix/backend-lifespan`, väntar på PR)

- `backend/app/main.py` stänger HTTP-klienten i en `lifespan`-hook i stället för den föråldrade `on_event`-kroken; `backend/tests/test_lifespan.py`.
- FastAPI-stacken (`fastapi`, `starlette`, `uvicorn`, `httpx`, `python-multipart`) höjs i `backend/requirements.txt` förbi 14 säkerhetsmeddelanden, och CI granskar backendens installerade paket med `pip-audit` (`.github/workflows/ci.yml`). Grenen med taken ovan bygger på den här.

## Kända begränsningar

- På main läser den allmänna proxyn hela request-bodyn i minnet (`await request.body()`) och BFF:en sätter inget eget tak för den. Taket kommer från Next (2 GB, se ovan). Det gäller JSON-anropen; uppladdningarna går genom `UploadFile`. Ett tak i BFF:en är på gång, se [På gång](#på-gång-inte-på-main).
- BFF:en har ingen egen rate limiting. Skydda publika testmiljöer i ingressen.
- Sessionslagret och cachen med signerade URL:er är process-lokala: en backendreplik.
