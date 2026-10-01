# Drift

Syfte: Samla det en operatör behöver: miljövariabler, Compose och produktionsimagen, Dokploy-stegen, hälsokontroller, loggar, säkerhetsheaders och felsökning.

Läs detta när: Du driftsätter eller uppdaterar modulen, ska sätta upp den i en Eneo-installation, byter organisationens märke eller felsöker något i en körande miljö.

Hör ihop med: [Backend](backend.md#inställningar), [Inloggning och session](auth-and-session.md), [Lokal utveckling](development.md), [Arkitektur](architecture.md#driftsättning), [Kvalitetsgrindar](quality-gates.md)

## Två sätt att köra

| | Produktionsimagen | Tvåcontainer-Compose |
|---|---|---|
| Fil | `Dockerfile` i roten | `docker-compose.yml` |
| Innehåll | Next.js och FastAPI i en container under supervisord | Tjänsterna `frontend` och `speech-to-text-backend` |
| Port | 3001 | 3000 (frontend), 8000 (backend, bara internt) |
| Används för | Eneos modulinstallation, publicerad som `ghcr.io/eneo-ai/eneo-mod-speech-to-text` | Lokal utveckling och fristående Dokploy-deploy |
| Hälsokontroll | `/health` genom hela Next till FastAPI-kedjan | `/api/healthz` på respektive tjänst |

Diagram: [Driftsättning](architecture.md#driftsättning).

## Miljövariabler

Reglerna för varje backendvariabel (krav, format, standardvärden) står i [Backend](backend.md#inställningar). Här är vad en operatör sätter och var.

| Variabel | Läses av | Exempelvärde (Sundsvalls fristående miljö) | Anmärkning |
|---|---|---|---|
| `ENEO_BACKEND_URL` | backend | `https://flow.sundsvall.dev` | `http://backend:8000` bara på Eneos `module_net` (imagen), aldrig i tvåcontainer-Compose, där `backend` inte finns. |
| `ENEO_PUBLIC_URL` | backend | `https://flow.sundsvall.dev` | Krävs i `eneo_sso`. |
| `MODULE_PUBLIC_URL` | backend | `https://transkribering.sundsvall.dev` | |
| `MODULE_KEY` | backend | `speech-to-text` | |
| `ENEO_API_KEY` | backend | en `sk_…`-nyckel från Eneo med rätt space-scope | Secret. |
| `ENEO_API_KEY_HEADER_NAME` | backend | samma som Eneos `API_KEY_HEADER_NAME` (standard `X-API-Key`) | |
| `SESSION_SECRET` | backend | minst 32 slumpmässiga tecken | Secret. Generering: [Lokal utveckling](development.md#med-docker-compose). |
| `AUTH_MODE` | backend | `eneo_sso` (standard) eller tillfälligt `access_code` | |
| `APP_ACCESS_CODE` | backend | endast i `access_code`; en separat, slumpmässig Dokploy-secret | Aldrig incheckad. |
| `COOKIE_SECURE` | backend | `true` | `false` bara för lokal `http://localhost`. `true` kräver HTTPS. |
| `DEMO_SPACE_ID` | backend | krävs i `access_code` | Se [Backend](backend.md#inställningar). |
| `UPLOAD_PROXY_TIMEOUT_SECONDS` | backend | valfri, standard `1800` | Höj aldrig över Nexts tystnadsgräns utan att höja den också (`frontend/next.config.mjs`, `experimental.proxyTimeout`, 31 minuter). |
| `SESSION_MAX_AGE_MINUTES` | backend | valfri, standard `480` | I `eneo_sso` gäller det tidigaste av detta och Eneos `MODULE_AUTH_MAX_SESSION_HOURS`. Går inte att sätta via Compose, se [Kända luckor](#kända-luckor). |
| `MAX_BODY_BYTES` | backend | valfri, standard `10485760` (10 MiB) | (på gång: `fix/backend-body-limits`, väntar på PR). Tak för varje request-body utom uppladdningar, 413 över taket. Ett tomt värde nekas av `backend/app/config.py`; Compose använder det numeriska standardvärdet. Se [Backend](backend.md#på-gång-inte-på-main). |
| `MAX_UPLOAD_BYTES` | backend | valfri, standard `1073741824` (1 GiB) | (på gång: `fix/backend-body-limits`, väntar på PR). Tak för en uppladdad fil. Höj den om Eneos flöden tar emot större ljudfiler. |
| `ORGANIZATION_NAME`, `ORGANIZATION_LOGO`, `ORGANIZATION_LOGO_DARK`, `SHOW_ORGANIZATION`, `ORGANIZATION_ACCENT`, `ORGANIZATION_ACCENT_DARK` | backend | valfria | Namn, logga och accentfärg. Utan dem visas Sundsvalls kommun och modulens standardblå (`#004595`). En accentfärg som inte når 4,5:1 mot sidans ytor stoppar start. Variablerna, kraven och felmeddelandena: [Byt organisation](branding.md). |
| `NEXT_PUBLIC_SPEAKER_REVIEW_ENABLED` | frontend, vid byggtid | `false` | Byggargument i Dockerfile och Compose. Se [Granska transkriptet](transcript-review.md). |
| `INTERNAL_API_BASE` | frontend | `http://127.0.0.1:8000` i imagen, `http://speech-to-text-backend:8000` i Compose | Dit Nexts rewrite skickar `/api/*` och dit sidan hämtar branding. Rewrite-målet bränns in vid bygget (`frontend/playwright.prod.config.ts`), så bygge och körning ska ha samma värde (`frontend/lib/backend-base.mjs`). |
| `PORT`, `HOSTNAME` | frontend (Next standalone) | `3001` och `0.0.0.0` i imagen | |
| `FOUNDATION_CHECK` | frontend, vid byggtid | tom | Kompilerar in utvecklingssidan `/dev/foundation` för testerna. Sätts aldrig i en image: utan den finns ingen av sidans kod i bygget (`frontend/next.config.mjs`). |

Äldre exempelvärden som `MODULE_ID` och `TAL_TILL_TEXT_API_KEY` läses medvetet inte av imagen.

## Kontrakt mot Eneos modul-overlay

Produktionsimagen exponerar port 3001 och en hälsokontroll på `/health`. Eneos Compose-overlay ska ge tjänsten endast `module_net` och skicka följande canonical env-namn:

| Variabel | Värde |
|---|---|
| `ENEO_BACKEND_URL` | `http://backend:8000` |
| `ENEO_PUBLIC_URL` | `https://<eneo-domän>` |
| `MODULE_PUBLIC_URL` | `https://<modul-domän>` |
| `MODULE_KEY` | `speech-to-text` |
| `ENEO_API_KEY` | modulspecifik `sk_`-nyckel |
| `ENEO_API_KEY_HEADER_NAME` | Eneos `API_KEY_HEADER_NAME`, standard `X-API-Key` |
| `SESSION_SECRET` | slumpmässiga 32+ tecken |
| `AUTH_MODE` | `eneo_sso` |

`ENEO_PUBLIC_URL` krävs bara i `eneo_sso`. `APP_ACCESS_CODE` får bara sättas med `AUTH_MODE=access_code` och ska då tillföras som secret, aldrig checkas in. Overlay-filen ska mappa operatörens secret till `ENEO_API_KEY`, så att det finns ett canonical konfigurationskontrakt i modulprocessen.

## Compose

`docker-compose.yml` har två tjänster:

| Tjänst | Port | Hälsokontroll | Anmärkning |
|---|---|---|---|
| `speech-to-text-backend` | 8000, bara `expose` | `GET http://127.0.0.1:8000/api/healthz` | Exponeras inte externt. Det unika tjänstenamnet undviker DNS-kollision med Eneos egen backend på Dokploys gemensamma nätverk. |
| `frontend` | 3000, bara `expose` | `GET http://127.0.0.1:3000/api/healthz` (genom rewriten) | Startar först när backend är `healthy`. Pekar mot backend med `INTERNAL_API_BASE`. |

`docker-compose.override.yml` slås ihop automatiskt av `docker compose up` och publicerar port 3000 lokalt. Dokploy använder uttryckligen `-f docker-compose.yml`, så filen ignoreras där. Båda tjänsterna har `restart: unless-stopped`. `backend/tests/test_deployment_compose.py` kontrollerar att frontend pekar på tjänstenamnet och väntar på att backend är frisk.

## Produktionsimagen

`Dockerfile` i roten bygger i tre steg: frontend (Node 22), backend-miljö (Python 3.12) och körmiljö.

- Körmiljön är Python 3.12 med Nodes binär kopierad från `node:22-bookworm-slim`, och körs som användaren `module`.
- `deploy/supervisord.conf` startar två program: `uvicorn app.main:app` på `127.0.0.1:8000` (med `--no-access-log` och WebSocket-gränserna) och Nexts `node /app/frontend/server.js`. Båda startas om vid oväntade fel (`autorestart=unexpected`), loggar till containerns stdout och stderr, och stoppas som grupp.
- `HEALTHCHECK` frågar `http://127.0.0.1:3001/health` var 30:e sekund, vilket går genom Next till FastAPI.
- Backendens accesslogg är avstängd så att callbackens ticket och state inte hamnar i loggarna.

Supervisor övervakar och startar om processerna vid oväntade fel; en omstart av backend ger ny login (se nedan).

## Sessionslagret är processlokalt

Sessionslagret ligger i backendprocessens minne, avsiktligt, eftersom produktionsimagen kör en backendprocess. En omstart kräver ny login. Innan flera backend-repliker används måste lagret flyttas till en delad store; annars kan en request landa hos en replik som inte äger sessionen. Det gäller även cachen med signerade fil-URL:er. Se [Inloggning och session](auth-and-session.md#sessionslagret).

## Inget att säkerhetskopiera

Modulen har ingen databas och inga volymer; den enda monteringen är en valfri, skrivskyddad mapp med en logotyp. Sessioner ligger i minnet, inspelningar sparas i användarens webbläsare tills Eneo har tagit emot dem, och flöden, körningar och filer ägs av Eneo. Säkerhetskopiera Eneo, inte modulen.

## Dokploy (exempel: `transkribering.sundsvall.dev`)

1. **Skapa ett Compose-projekt** i Dokploy och peka på det här repot.
2. **Sätt miljövariablerna** i Dokploy-gränssnittet enligt tabellen ovan (motsvarar `.env`).
3. **Konfigurera domänen** `transkribering.sundsvall.dev` i Dokploy och peka mot tjänsten `frontend` (port 3000). Dokploy och Traefik sköter HTTPS-certifikatet.
4. **Deploya.** Dokploy bygger båda containrarna via `docker-compose.yml`. Backend exponeras inte externt, bara internt mot `frontend` på `http://speech-to-text-backend:8000`.
5. **Verifiera:**
   - `https://transkribering.sundsvall.dev/` visar Eneo-login eller kodformulär enligt `AUTH_MODE`.
   - `https://transkribering.sundsvall.dev/api/healthz` svarar `{"ok":true}`.
   - I `eneo_sso`: callback-URL:en blir ren efter lyckad login.
   - I båda lägen: flödeslistan visas och ett riktigt Flow-anrop lyckas.

Ingress- eller Traefik-loggning måste utesluta callbackens query string.

## Egen organisation i sidhuvudet

Namn, logga och accentfärg är inställningar på backend-tjänsten, och en annan organisation byter dem utan att bygga om imagen: sätt variablerna, montera loggan skrivskyddat i backend-tjänsten (`docker-compose.yml` har en förberedd rad som kommentar) och starta om tjänsterna. Steg, krav på loggan, kontrastreglerna för accentfärgen, felmeddelandena vid start och hur du kontrollerar resultatet står bara i [Byt organisation](branding.md). Hur märket och färgen kommer in i gränssnittet: [Arkitektur](architecture.md#var-organisationens-märke-och-accent-kommer-in).

## Säkerhetsheaders

Next sätter dessa på alla svar (`headers()` i `frontend/next.config.mjs`):

| Header | Värde |
|---|---|
| `Referrer-Policy` | `no-referrer` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Permissions-Policy` | `camera=(), geolocation=(), microphone=(self)` |
| `Content-Security-Policy` | `default-src 'self'`; `script-src 'self' 'unsafe-inline'`; `style-src 'self' 'unsafe-inline'`; `img-src 'self' data: blob:`; `media-src 'self' blob:`; `font-src 'self'`; `connect-src 'self'`; `base-uri 'self'`; `form-action 'self'`; `frame-ancestors 'none'`; `object-src 'none'` |

- `script-src` behåller `'unsafe-inline'` eftersom Nexts hydreringsskript är inline och skulle blockeras utan nonce per request. `'unsafe-eval'` läggs till bara i `next dev`; produktionsbygget får aldrig med det.
- `blob:` och `data:` behövs för förhandslyssning på inspelningen i webbläsaren.
- Förhandsvisningen av en PDF på resultatsidan har en egen regel för `/api/eneo/flows/:flowId/runs/:runId/artifacts/:fileId/content`: `X-Frame-Options: SAMEORIGIN` och `frame-ancestors 'self'`. Backend sätter samma värden på PDF:er som visas inline.
- Inga typsnitt eller skript laddas från andra origins.

Callbackens svar har dessutom `Cache-Control: no-store` och `Referrer-Policy: no-referrer` (se [Inloggning och session](auth-and-session.md)).

## Loggar

- Produktionsimagen loggar till containerns stdout och stderr. `docker logs <container>` visar båda processerna.
- Tvåcontainer-Compose: `docker compose logs -f speech-to-text-backend` och `docker compose logs -f frontend`.
- Uvicorns accesslogg är av. Backend loggar fel och varningar med tydliga etiketter (till exempel upstream-fel, misslyckad ticketväxling, en logotyp som inte kunde läsas).

## CI och publicering

`.github/workflows/ci.yml` körs vid pull request och push till `main`:

| Jobb | Vad |
|---|---|
| `backend` | `python -m unittest discover -s tests` i `backend/` (Python 3.12). På gång (`fix/backend-lifespan`, väntar på PR): därefter `pip-audit` på de installerade paketen. |
| `frontend` | `npm ci`, `npm test`, `npm run lint`, `npm run astryx -- doctor`, kontroll att det byggda temat är aktuellt (`npm run theme:build` och `git diff --exit-code -- kit/theme/built`), `npm audit --omit=dev --audit-level=high`, `npm run build` (Node 22). |
| `frontend-browser` | `npm run test:prod` i tre motorer, samt tillgänglighetsgrindens projekt `phone-390-light` och `laptop-1440-light`. |
| `compose` | `docker compose --env-file .env.example config -q`. |
| `image` | Bygger produktionsimagen. |

`.github/workflows/publish.yml` publicerar imagen till `ghcr.io/eneo-ai/eneo-mod-speech-to-text` vid push till `main` (taggen `latest`) och vid taggar `v*`, och taggar varje bygge med commitens sha.

## Beroendesäkerhet

GitHubs dependency graph och Dependabot alerts är aktiverade för repot (uppgift från tidigare dokumentation, inte omverifierad här). Kända sårbarheter visas under **Security, Dependabot alerts** och hanteras manuellt. Dependabot security updates är avstängt och repot har ingen `.github/dependabot.yml`; GitHub skapar därför inga automatiska dependency-PR:er. Ändra inte detta utan ett separat beslut om PR-automation. CI stoppar dessutom vid fynd i produktionsberoendena: `npm audit` för frontend (från nivån high, se ovan) och `pip-audit` för backends installerade Python-paket (alla kända sårbarheter).

På gång (`fix/backend-lifespan`, väntar på PR): backendens FastAPI-stack höjs förbi 14 säkerhetsmeddelanden i `backend/requirements.txt`, och CI granskar dessutom backendens installerade Python-paket med `pip-audit` och misslyckas vid fynd (`.github/workflows/ci.yml`). Se [Backend](backend.md#på-gång-inte-på-main).

## Vid problem

| Symptom | Trolig orsak och åtgärd |
|---|---|
| Backend kraschar vid start | Kontrollera basvariablerna samt `ENEO_PUBLIC_URL` i SSO-läge eller `APP_ACCESS_CODE` i kodläge. `ENEO_API_KEY` krävs i båda. Felet säger vilken variabel. |
| Login misslyckas efter callback | Kontrollera exakt registrerad callback-URL, module key, bunden servicenyckel och att `COOKIE_SECURE=true` endast används bakom HTTPS. Felkoderna står i [Inloggning och session](auth-and-session.md#om-callbacken-misslyckas). |
| Kodlogin fungerar men Flow-anrop nekas | Eneo-routen kräver sannolikt modultoken. Byt till `eneo_sso` när handoff-kontraktet är deployat. |
| 502 vid uppladdning | Eneo-lastbalanserarproblem. Kolla loggen för backend (`docker compose logs speech-to-text-backend`) efter det exakta httpx-felet. |
| 504 vid uppladdning | Backendens upload-vidarebefordran till Eneo tog längre än `UPLOAD_PROXY_TIMEOUT_SECONDS`. |
| Uppladdningen når 100 % och faller | Svaret dröjde längre än Next-proxyns tystnadsgräns (`experimental.proxyTimeout` i `frontend/next.config.mjs`, 31 minuter). Håll den över `UPLOAD_PROXY_TIMEOUT_SECONDS` om du höjer den. |
| "Det gick inte att skicka" under uppladdningen | Eneo svarade med serverfel på fyra försök att ladda upp samma fil (nätavbrott och 429 räknas inte). Inspelningen ligger kvar i webbläsaren och kan skickas igen med "Försök igen". Se [Inspelaren](recording.md#uppladdning-och-nya-försök). |
| 413 | (på gång: `fix/backend-body-limits`, väntar på PR). Ett tak för body nåddes: `MAX_BODY_BYTES` (JSON-anrop) eller `MAX_UPLOAD_BYTES` (uppladdning). Höj rätt variabel om gränsen är för snäv. |
| 411 vid uppladdning | (på gång: `fix/backend-body-limits`, väntar på PR). En uppladdning utan `Content-Length`. Webbläsare skickar alltid en; en annan klient eller en proxy som skickar bodyn i delar är orsaken. |
| Tom flödeslista | Användaren är inte medlem i något space med publicerade flöden, eller modulnyckelns space scope utesluter dem (en nyckel som är scopad till ett space användaren inte är med i ger en tom lista). I `access_code` med en tjänstenyckel: kontrollera att `DEMO_SPACE_ID` pekar på rätt space. |
| Flödeslistan säger att flödena inte kan visas | I `access_code` saknas `DEMO_SPACE_ID`; backend loggade ett fel vid start. |
| Backend startar om i en slinga efter en ändrad accentfärg | `ORGANIZATION_ACCENT` eller `ORGANIZATION_ACCENT_DARK` är inte läsbar nog (under 4,5:1) eller har fel form, och backend vägrar starta. Felmeddelandet i loggen (`docker compose logs speech-to-text-backend`) säger vad som mättes och vad som ska göras: [Byt organisation](branding.md#felmeddelanden-vid-start). |
| En gammal färg visas efter ett byte | Accentens stilmall får cachas i fem minuter (`Cache-Control: max-age=300`). Ladda om sidan eller öppna den i ett privat fönster. |
| Alla blir utloggade | Backend startade om: sessionslagret är processlokalt. |

## Kända luckor

Skillnader mellan vad som är dokumenterat eller möjligt och vad konfigurationen gör i dag. De är inte rättade här (de ligger i kod och konfiguration, inte i dokumentationen).

| Lucka | Var | Följd |
|---|---|---|
| `SESSION_MAX_AGE_MINUTES` läses av backend och är dokumenterad, men `docker-compose.yml` skickar den aldrig vidare, och den står inte i `.env.example`. | `docker-compose.yml`, `backend/app/config.py` | Compose och en Dokploy-deploy av den filen kan inte ändra inloggningens längd: Compose för bara vidare de variabler som räknas upp, så en variabel i Dokploy-gränssnittet når inte containern. Standarden 480 minuter gäller. Produktionsimagen har ingen sådan spärr: där räcker det att miljön ger variabeln till processen. Rättelsen är en rad i `docker-compose.yml` (och en kommentar i `.env.example`). |
