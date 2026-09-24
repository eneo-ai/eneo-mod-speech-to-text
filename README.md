# Eneo Speech-to-Text Module

Lyssna är en Eneo-modul som låter en inloggad användare spela in samtal i browsern, skicka det till ett publicerat Eneo-flöde, och visa resultatet (transkript + sammanfattning + ev. genererade filer).

```
Browser  →  Next.js (3002 dev / 3001 prod)  →  FastAPI (intern, port 8000)
                │                         │
                UI               module session + BFF proxy
                                          │
                                          └──service key (+ user token i SSO)──→  Eneo
```

Eneos API-nyckel och, i SSO-läge, module-user-token stannar i backendprocessen. Browserns HttpOnly-cookie innehåller bara ett slumpmässigt, opakt sessions-ID och returnerar aldrig credentials till frontend-JavaScript. Logout återkallar sessionen direkt. Frontend pratar endast same-origin via Next.js rewrite.

Modulen har två uttryckliga auth-lägen: `eneo_sso` är permanent standard och `access_code` är en tillfällig testgrind tills Eneos modulhandoff är deployad. Lägena blandas aldrig och access-koden ersätter inte `ENEO_API_KEY`.

Frontendens designsystem ägs lokalt i `frontend/components/ui` och följer shadcn-konventionen. Det finns inget runtime- eller byggberoende till `@sk-web-gui`; färgtokens och komponentvarianter kan därför utvecklas och granskas tillsammans med modulen.

Sessionslagret är avsiktligt processlokalt eftersom produktionsimagen kör en backendprocess. En omstart kräver ny login. Innan flera backend-repliker används måste lagret flyttas till en delad store; annars kan en request landa hos en replik som inte äger sessionen.

Produktionsimagen `ghcr.io/eneo-ai/eneo-mod-speech-to-text` paketerar båda processerna i en isolerad modulcontainer på port 3001. Supervisor övervakar och startar om processerna vid oväntade fel; imagen har dessutom ett healthcheck genom hela Next→FastAPI-kedjan. Tvåcontainer-Compose-filen används för lokal utveckling och fristående Dokploy-deploy.

---

## Local development

```bash
cp .env.example .env
# Fyll i auth-läge, Eneo/module-URL:er, ENEO_API_KEY och SESSION_SECRET
# (samt DEMO_SPACE_ID i access_code-läget).
# Sätt COOKIE_SECURE=false för lokal http://localhost.

docker compose up --build
open http://localhost:3000
```

Produktionsimagen kan verifieras lokalt med:

```bash
docker build -t eneo-mod-speech-to-text:test .
docker run --rm --env-file .env -p 3001:3001 eneo-mod-speech-to-text:test
curl -fsS http://localhost:3001/health
```

Generera `SESSION_SECRET` med:

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Loggar:

```bash
docker compose logs -f backend
docker compose logs -f frontend
```

### VS Code Dev Container

Projektet har en devcontainer med Python 3.12 och Node 20.

1. Öppna repot i VS Code.
2. Kör **Dev Containers: Reopen in Container** och öppna en **ny terminal i det VS Code-fönstret**. Kommandona nedan ska köras inne i containern, där repot ligger på `/workspaces/eneo-mod-speech-to-text`.
3. Skapa lokal miljöfil om den saknas:

```bash
cp .env.example .env
```

4. Fyll i `.env`. För lokal körning i devcontainern behöver `COOKIE_SECURE=false`.
5. Starta backend i en terminal inne i containern:

```bash
cd /workspaces/eneo-mod-speech-to-text
set -a
source .env
set +a
cd backend
.venv/bin/python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000 --no-access-log --ws-max-size 131072 --ws-max-queue 16
```

6. Starta frontend i en annan terminal inne i containern. Läs in `.env` även här så att frontendinställningar som `NEXT_PUBLIC_SPEAKER_REVIEW_ENABLED=true` används:

```bash
cd /workspaces/eneo-mod-speech-to-text
set -a
source .env
set +a
cd frontend
npm run dev
```

Starta om frontend efter att ha ändrat `NEXT_PUBLIC_`-inställningar.

Om du får `uvicorn: command not found` efter att ha aktiverat `.venv`: kontrollera
att terminalen verkligen är inne i containern. Miljön skapas där med Python 3.12;
den kan inte användas från macOS även om prompten visar `(.venv)`. Från en vanlig
terminal på datorn kan du gå in med `docker exec -it <containerns namn> bash`
(hitta namnet med `docker ps`) och sedan köra startkommandona ovan.

Öppna sedan `http://localhost:3002`. VS Code forwardar port `3002` och `8000`.
Dev-servern lyssnar avsiktligt på `3002`: Eneos egen devcontainer tar `3000`
(webb) och `8123` (API), och båda körs ofta samtidigt. I `next dev` proxas
`/api` automatiskt till `http://127.0.0.1:8000`; sätt `INTERNAL_API_BASE` om
backend körs någon annanstans. Produktionsimagen kör fortfarande på `3000`.

Mot ett lokalt Eneo i devcontainer: `ENEO_BACKEND_URL=http://host.docker.internal:8123`,
`ENEO_PUBLIC_URL=http://localhost:3000`, `MODULE_PUBLIC_URL=http://localhost:3002`
och `COOKIE_SECURE=false`. Snabbaste vägen är `AUTH_MODE=access_code` med en
`sk_`-nyckel (service, `flows = write`) skapad i Eneos admin; för riktig SSO
installeras modulen i Eneo med callback `http://localhost:3002/api/auth/callback`.

### Granska transkriptet

Med `NEXT_PUBLIC_SPEAKER_REVIEW_ENABLED=true` visar spelaren ett sammanhängande
transkript. Markera ord direkt med musen eller med Skift och piltangenter och välj
**Tilldela talare**. Markeringen kan gå över flera ursprungliga textfragment.
**Bekräfta [namn]** accepterar ett gemensamt talarförslag med ett klick.
**Lyssna** spelar markeringen med lite sammanhang. Klicka på ett ord med heldragen
understrykning för att flytta uppspelningen dit. Pausat ljud förblir pausat och
pågående uppspelning fortsätter från den nya positionen. Om ordtiden saknas
används passagens start. Det aktuella ordet visas med en tydlig blå bakgrund. **Rätta text** ändrar orden.
**Ångra** återställer den senaste ändringen och **Återställ talare** tar bort
beslut för de markerade orden.

Prickad understrykning visar ord där talaren behöver granskas. Klicka på passagen
för att markera hela, inklusive skiljetecken, eller använd Enter när den har fokus.
Dra över text för att välja en mindre del. **Nästa** markerar
nästa sådant ställe. Överlappsdetaljer finns under **Detaljer**. Namn som gäller
hela talaren ändras separat under **Talare** ovanför transkriptet.

Tester:

```bash
cd frontend && npm ci && npm test && npm run build
cd ../backend && .venv/bin/python -m unittest discover -s tests
cd .. && docker compose --env-file .env.example config -q
docker build -t eneo-mod-speech-to-text:test .
```

Tillgänglighetsgrinden (WCAG 2.2 AA) körs före push med `cd frontend && npx playwright install chromium && npm run test:a11y`. Den startar en stubbackend (`frontend/tests/e2e/stub-server.py`, bara för test) och `next dev` på port 3401 och besöker varje skärm med falsk mikrofon: axe på 320, 390, 1440, 1920, 2560 och 3440 px i ljust och mörkt, telefonerna och en surfplatta i båda riktningarna som pekskärm, forced colors, reducerad rörelse och 200 % zoom, där varje WCAG-överträdelse stoppar grinden oavsett allvarlighetsgrad och övriga axe-regler när de är allvarliga eller kritiska; tangentbordsvandringar där fokus mäts i den renderade sidan (en indikator med minst 3:1 förändring, inte skymd); ARIA-ögonblicksbilder och texten som når live-regionerna; reflow (inget innehåll utanför kanten eller avklippt, på de smalaste och bredaste skärmarna) och målstorlekar (24 px med mus, 44 px med finger, `pointer: coarse`). På 1920, 2560 och 3440 px körs alla kontroller per skärm i ljust och mörkt (axe, namn, målstorlekar, reflow och textavstånd); tangentbordsvandringarna och fokustesterna för dialoger, som mäter synligt och ej skymt fokus, körs på 1920 px, eftersom tangentbordsordning och fokushantering inte ändras på bredare skärmar. Stoppa din egen `npm run dev` i samma utcheckning först (Next tillåter en dev-server per utcheckning). Mätvärden per skärm hamnar i `frontend/test-results/a11y/*/findings.json`, rapporten i `frontend/test-results/a11y-report`. Efter en avsiktlig ändring i vad skärmläsaren får: granska och uppdatera ögonblicksbilderna med `npm run test:a11y -- aria.spec.ts --update-snapshots`.

Grinden bevisar DOM:en och den renderade sidan: roller, namn, tillstånd, fokus, kontrast, layout och vilken text som hamnar i live-regionerna. Vad en skärmläsare faktiskt läser upp är en manuell kontroll, liksom det axe inte kan avgöra själv (axe:s _incomplete_, listade som `manual check` i rapporten och i `findings.json`). PDF-förhandsvisningen visar PDF:en i webbläsarens egen visare, där en sida inte kan fånga Escape. Grinden kräver därför att visaren inte stänger in fokus: antingen är den inget tabbstopp och dialogen har en länk som öppnar filen i en ny flik, eller så leder Tab ut ur visaren tillbaka till dialogens kontroller och visaren visar synligt fokus. Escape ska stänga dialogen från dialogens egna kontroller; Escape inifrån visaren krävs inte.

Tidsgränser (WCAG 2.2.1): inloggningen varnar fem minuter före slutet och kan förnyas utan att lämna sidan. En granskningspaus visar när Eneo avbryter körningen. Kriteriet uppfylls bara när flödets granskningsfönster är längre än 20 timmar; Eneos standard är 14 dagar, och ett flöde som ställer in ett kortare fönster uppfyller det inte.

---

## Autentisering

`AUTH_MODE` väljer exakt ett inloggningsflöde. Default är `eneo_sso`; okända lägen eller en konfiguration som blandar SSO med `APP_ACCESS_CODE` stoppar backend vid start.

### Eneo SSO (`AUTH_MODE=eneo_sso`)

Modulen är ingen egen OIDC-klient. Eneo förblir installationens autentiseringsauktoritet och `ENEO_PUBLIC_URL` måste vara satt.

Flödet:

1. `GET /api/auth/login` skapar ett oförutsägbart, kortlivat `state`, binder det till en HttpOnly-cookie och skickar browsern till Eneos `/module-login` med `module_key=speech-to-text`.
2. Eneo autentiserar användaren och skickar tillbaka en engångsticket till `/api/auth/callback`.
3. Callbacken verifierar och förbrukar `state`, växlar ticket server-side med modulens registrerade service key och skapar en HttpOnly-modulsession.
4. Varje proxat Eneo-anrop skickar både modulens service key och den kortlivade module-user-token som BFF:en hämtar ur sessionen.
5. När halva tokenens livslängd har gått förnyar BFF:en den via `POST /api/v1/module-auth/{module_key}/token/refresh/`. Nekar Eneo förnyelsen, till exempel när Eneos sessionstak har passerats, avslutas modulsessionen och användaren loggar in igen.

Callbacken redirectar alltid till en ren URL och returnerar `Referrer-Policy: no-referrer`. Backendens Uvicorn-accesslogg är avstängd så att callbackens ticket och state inte hamnar i containerloggar. Ingress-/Traefik-loggning måste också exkludera callbackens query string.

> Denna modulimplementation förutsätter Eneos stabila `module_key`-kontrakt, frontend-route `/module-login` och Flow-resurser som kräver både service key och module-user-token.

### Tillfällig åtkomstkod (`AUTH_MODE=access_code`)

Detta läge finns endast för fristående test innan hela SSO-handoffen är deployad. Sätt `APP_ACCESS_CODE` som en Dokploy-secret med 16–256 tecken; generera den exempelvis med `python -c "import secrets; print(secrets.token_urlsafe(24))"` och rotera den vid behov. Koden jämförs i konstant tid i backend, skickas aldrig i URL:en och persisteras inte av applikationen. Vid lyckad login skapas samma sorts slumpmässiga, opaka HttpOnly-session som i SSO-läget.

Begränsningar:

- åtkomstkoden är en delad grind, inte en användaridentitet; den ger ingen per-person- eller tenant-audit;
- `ENEO_API_KEY` är fortfarande obligatorisk och används för anrop till Eneo;
- upstream-anrop skickar endast service key, aldrig en påhittad Bearer-token;
- när Eneo kräver både service key och module-user-token kommer Flow-anrop därför att nekas;
- sessionslagret är processlokalt, sessionen löper ut efter `SESSION_MAX_AGE_MINUTES` (default 8 timmar) och försvinner vid omstart;
- skydda publika testmiljöer med ingress-rate-limit; korta koder som `komin` nekas redan vid startup men testgrinden ersätter fortfarande inte riktig användarautentisering.

Avvecklingspunkt: när [eneo#536](https://github.com/eneo-ai/eneo/pull/536) är deployad och ett live-smoke-test har verifierat `/module-login` → callback/ticket exchange → `/api/v1/module-auth/speech-to-text/session/` samt ett Flow-anrop med dubbla credentials, byt till `AUTH_MODE=eneo_sso`, radera `APP_ACCESS_CODE` i Dokploy och ta bort access-code-koden, UI:t, dokumentationen och testerna i nästa cleanup-PR. Läget ska inte bli en permanent fallback.

### Kontrakt mot Eneos modul-overlay

Produktionsimagen exponerar port `3001` och healthcheck på `/health`. Eneos Compose-overlay ska ge tjänsten endast `module_net` och skicka följande canonical env-namn:

- `ENEO_BACKEND_URL=http://backend:8000`
- `ENEO_PUBLIC_URL=https://<eneo-domain>`
- `MODULE_PUBLIC_URL=https://<module-domain>`
- `MODULE_KEY=speech-to-text`
- `ENEO_API_KEY=<module-specific sk_ key>`
- `ENEO_API_KEY_HEADER_NAME=<Eneos API_KEY_HEADER_NAME, default X-API-Key>`
- `SESSION_SECRET=<random 32+ characters>`
- `AUTH_MODE=eneo_sso`

`ENEO_PUBLIC_URL` krävs endast i `eneo_sso`. `APP_ACCESS_CODE` får endast sättas med `AUTH_MODE=access_code` och ska då tillföras som secret, aldrig checkas in.

Äldre exempelvärden som `MODULE_ID` och `TAL_TILL_TEXT_API_KEY` läses medvetet inte av imagen. Overlay-filen ska mappa operatörens secret till `ENEO_API_KEY`; då finns ett canonical konfigurationskontrakt i modulprocessen.

---

## Deploy på Dokploy (`transkribering.sundsvall.dev`)

1. **Skapa Compose-projekt i Dokploy** och peka på det här repot.

2. **Sätt environment variables** i Dokploy-UI:t (motsvarande `.env`):

   | Variabel | Värde |
   |---|---|
   | `ENEO_BACKEND_URL` | `https://flow.sundsvall.dev` i fristående Dokploy; `http://backend:8000` endast på Eneos `module_net` |
   | `ENEO_PUBLIC_URL` | `https://flow.sundsvall.dev` (krävs i `eneo_sso`) |
   | `MODULE_PUBLIC_URL` | `https://transkribering.sundsvall.dev` |
   | `MODULE_KEY` | `speech-to-text` |
   | `ENEO_API_KEY` | en `sk_…`-nyckel från Eneo med rätt space-scope |
   | `ENEO_API_KEY_HEADER_NAME` | samma headernamn som Eneos `API_KEY_HEADER_NAME` (default `X-API-Key`) |
   | `SESSION_SECRET` | minst 32 tecken slumpmässigt (se ovan) |
   | `AUTH_MODE` | `eneo_sso` (standard) eller tillfälligt `access_code` |
   | `APP_ACCESS_CODE` | endast i `access_code`; en separat, slumpmässig Dokploy-secret |
   | `COOKIE_SECURE` | `true` |
   | `DEMO_SPACE_ID` | krävs i `access_code` för flödeslistan: modulnyckeln listar bara flödena i detta space (utan det loggar backend ett fel vid start och sidan säger att flödena inte kan visas). Används inte med `eneo_sso`, där listan omfattar alla användarens spaces |
   | `UPLOAD_PROXY_TIMEOUT_SECONDS` | (valfritt) timeout för backendens upload-forwarding till Eneo, default `1800` |
   | `SESSION_MAX_AGE_MINUTES` | (valfritt) hur länge en inloggning gäller, default `480` (8 timmar). I `eneo_sso` gäller min(detta, Eneos `MODULE_AUTH_MAX_SESSION_HOURS`); den kortlivade modultoken förnyas automatiskt via Eneo under tiden |
   | `ORGANIZATION_NAME`, `ORGANIZATION_LOGO`, `ORGANIZATION_LOGO_DARK`, `SHOW_ORGANIZATION` | (valfritt) organisationen i sidhuvudet, se [Egen organisation i sidhuvudet](#egen-organisation-i-sidhuvudet); utan dem visas Sundsvalls kommun |

3. **Konfigurera domänen** `transkribering.sundsvall.dev` i Dokploy och peka mot tjänsten `frontend` (port 3000). Dokploy/Traefik sköter HTTPS-certifikatet.

4. **Deploy.** Dokploy bygger båda containrarna via `docker-compose.yml`. Backend exponeras inte externt — bara internt mot `frontend` på `http://speech-to-text-backend:8000`. Det unika tjänstenamnet undviker DNS-kollision med Eneos egen backend på Dokploys gemensamma nätverk.

5. **Verifiera** efter deploy:
   - `https://transkribering.sundsvall.dev/` → Eneo-login eller kodformulär enligt `AUTH_MODE`
   - `https://transkribering.sundsvall.dev/api/healthz` → `{"ok":true}`
   - `eneo_sso`: callback-URL:en blir ren efter lyckad login
   - båda lägen: flödeslistan visas och ett riktigt Flow-anrop lyckas

### Egen organisation i sidhuvudet

Sidhuvudet visar Sundsvalls kommuns logga bredvid "Tal till text" om inget annat anges. En annan kommun eller
myndighet byter den utan att bygga om:

1. Montera en mapp med loggan i backend-tjänsten, till exempel `./branding:/branding:ro`.
2. Sätt `ORGANIZATION_NAME=Umeå kommun` och `ORGANIZATION_LOGO=/branding/logo.svg` (SVG eller PNG, högst 1 MiB); `ORGANIZATION_LOGO_DARK` är en valfri logga för mörkt tema.
3. Starta om tjänsterna. `SHOW_ORGANIZATION=false` visar i stället bara "Tal till text".

Namnet är loggans alternativtext. Ett namn utan logga visas som text. En fil som saknas eller inte är en SVG eller
PNG loggas en gång vid start, och namnet visas i stället. Backend serverar loggan från samma origin
(`/api/branding/logo/light` och `/dark`), eftersom sidans CSP bara tillåter egna bilder. Färgerna följer
fortfarande modulens tema.

### Vid problem

- **Backend kraschar vid start:** kontrollera basvariablerna samt `ENEO_PUBLIC_URL` i SSO-läge eller `APP_ACCESS_CODE` i kodläge. `ENEO_API_KEY` krävs i båda.
- **Login misslyckas efter callback:** kontrollera exakt registrerad callback-URL, module key, bunden service key och att `COOKIE_SECURE=true` endast används bakom HTTPS.
- **Kodlogin fungerar men Flow-anrop nekas:** Eneo-routen kräver sannolikt module-user-token; byt till `eneo_sso` när handoff-kontraktet är deployat.
- **502 vid uppladdning:** Eneo-load-balancer-problem; kolla `docker compose logs backend` för exakt httpx-fel.
- **504 vid uppladdning:** backendens upload-forwarding till Eneo tog längre än `UPLOAD_PROXY_TIMEOUT_SECONDS`.
- **Tom flödeslista:** användaren är inte medlem i något space med publicerade flöden, eller modulnyckelns space scope utesluter dem (en nyckel som är scopad till ett space användaren inte är med i ger en tom lista). I `access_code` med en tjänstenyckel: kontrollera att `DEMO_SPACE_ID` pekar på rätt space.

---

## Dependency security

GitHubs dependency graph och Dependabot alerts är aktiverade för repot. Kända sårbarheter visas under **Security → Dependabot alerts** och hanteras manuellt.

Dependabot security updates är avstängt och repot har ingen `.github/dependabot.yml`; GitHub skapar därför inga automatiska dependency-PR:er. Ändra inte detta utan ett separat beslut om PR-automation.

---

## Robust ljudinspelning och Eneo Flow-körning

Appen bygger körningen från Eneos publicerade flow-kontrakt:

1. `GET /api/v1/flows/{flowId}/run-contract/` hämtas innan användaren kör flödet.
2. Ljudsteget väljs från `steps_requiring_input`.
3. Filstorlek och MIME-typ valideras mot stegets `max_file_size_bytes` och `accepted_mimetypes`.
4. Ljud laddas upp till step-scoped runtime-endpointen:
   `POST /api/v1/flows/{flowId}/steps/{stepId}/runtime-files/`.
5. Körningen startas först efter lyckad upload och skickar filen via:

```json
{
  "expected_flow_version": 3,
  "step_inputs": {
    "step-id": {
      "file_ids": ["uploaded-file-id"]
    }
  }
}
```

### Granskning och talarmappning (human-in-the-loop)

Ett publicerat flöde kan innehålla steg med `review_policy` som pausar körningen
i status `awaiting_review`. Appen pollar `GET /api/v1/flows/{flowId}/runs/{runId}/`
och hämtar då den aktiva checkpointen via
`GET …/runs/{runId}/review-checkpoints/active/`.

Talarmappning (Eneo-stegtypen `output_mode = "speaker_mapping"`) är inget eget
API utan en sådan checkpoint med `review_mode = "edit"`. Appen känner igen den på
att `current_payload_json` innehåller nyckeln `speaker_mapping` med talarinventariet
(`SPEAKER_00`, `SPEAKER_01` … med antal repliker och exempelrepliker) och
`structured.speakers` med modellens namnförslag. Före körningen avslöjas steget i
run-kontraktets `steps_requiring_review` genom det pinnade `output_contract`;
appen visar då en hint i inställningsvyn.

Vyn "Vem är vem?" låter användaren välja deltagare per talare (deltagarlistan
från formulärfältet, "Annan person …" med fritext, eller "Ingen"). Vid
"Spara och fortsätt" skickas mappningen som stegets output:

```json
PATCH /api/v1/flows/{flowId}/runs/{runId}/review-checkpoints/{checkpointId}/
{
  "expected_checkpoint_revision": 1,
  "edited_value": {
    "speakers": [
      { "label": "SPEAKER_00", "name": "Anna", "confidence": "high", "evidence": "…" },
      { "label": "SPEAKER_01", "name": null, "confidence": "low", "evidence": "" }
    ]
  }
}
```

Vyn spelar samtidigt upp inspelningen med ett följande transkript. Segmenten
(talare, start/slut per replik) hämtas från transkriberingsstegets
`input_payload_json.transcription` via `GET …/runs/{runId}/steps/`, ordtiderna
från `GET …/steps/{stepId}/transcript-words/` (404 = inga ordtider, då markeras
bara repliken). Saknas segment parsas den renderade texten med sekundprecision.

Ljudet strömmas same-origin via modulens backend:
`GET /api/eneo/flows/{flowId}/runs/{runId}/input-files/{fileId}/audio`. Backend
hämtar Eneos signerade URL (`POST …/input-files/{fileId}/signed-url/`) med sina
egna credentials, cachar den per session tills den går ut och vidarebefordrar
`Range`-förfrågningar oförändrat. Browsern ser aldrig Eneos token, och CSP:ns
`media-src 'self'` behålls.

Repliker kan rättas direkt i spelaren (hovra → penna) och en replikgrupp kan
byta talare (klicka på namnet). Rättningarna är icke-destruktiva och sparas
per ändring till Eneos `…/steps/{stepId}/transcript-corrections/` med
replace-semantik och `expected_revision`; Eneo viker in dem i transkriptet när
granskningen godkänns. Rättning kräver att steget lagrade `transcription.segments`
(fallback-parsad text går inte att förankra). Samma spelare, skrivskyddad,
visas på resultatsidan för alla körningar med ett transkriberingssteg, med
namnen från ett eventuellt speaker-mapping-steg.

Varje etikett i inventariet måste förekomma exakt en gång; talare utan namn
behåller sin etikett. Eneo räknar om transkriptet med namnen och uppdaterar
`{{transkribering}}` på körningen. Därefter anropas `…/approve/` och
`…/resume/` (med `Idempotency-Key`) som för alla andra checkpoints, och appen
fortsätter polla. `edited_value` är alltid stegets output i sig — en sträng för
`text`-steg, ett JSON-värde för `json`-steg — aldrig payload-kuvertet.

Next.js proxar `/api/*` till FastAPI via rewrites och klonar då request-bodyn
med ett standardtak på 10 MB; större bodies kapas tyst. `next.config.mjs`
höjer taket (`experimental.proxyClientMaxBodySize`) så att ljudfiler upp till
Eneos `max_file_size_bytes` passerar. Den klonade bodyn hålls i minnet under
uppladdningen, så taket är samtidigt ett minnestak per upload i Next-processen.

Browsern ska inte använda en hårdkodad 120-sekunders timeout för stora ljudfiler.
Klienten räknar i stället upload-timeout från `runtime_upload_policy` i
flow-kontraktet och håller uppladdningen vid liv så länge progress fortsätter.

Inspelaren använder komprimerat browserformat, i första hand WebM/Opus när
flödet accepterar det, och ber `MediaRecorder` om korta chunks under inspelning.
Det minskar risken att långa möten bygger upp en enda stor intern recorder-buffer.
Eneo-körningen startar fortfarande först när hela ljudfilen har laddats upp och
ett `file_id` finns; Strömma (nedan) strömmar bara en förhandstext.

### Inspelningen sparas på enheten

Inspelaren sparar en ljudbit varannan sekund i webbläsarens IndexedDB, under
inspelningens id, del och löpnummer. En omladdning, en krasch eller en utgången
session förlorar därför högst den senaste biten. Inspelningen visas sedan som
osänd i flödeslistan och på flödets sida, med **Skicka**, **Spara som fil** och
**Ta bort**, för den som spelade in den. Den lokala kopian tas bort först när
Eneo har tagit emot körningen. Utan IndexedDB (vissa privata lägen) finns
inspelningen bara i fliken, och det står i inspelaren.

Tappar inspelningen mikrofonen, till exempel vid ett samtal eller när en telefon
lägger sidan i bakgrunden, pausas den och **Fortsätt spela in** startar en ny
del. Det går också efter en omladdning: en inspelning som avbröts utan stopp
visas som osänd på flödets sida med **Fortsätt spela in**, som spelar in direkt
i en ny del av samma inspelning, med tiden räknad från det som redan sparats.
Efter **Stoppa** finns **Fortsätt spela in** också bredvid **Skapa dokument**:
det spelar in en ny del av samma inspelning på samma sätt, tills inspelningen
har börjat skickas. Med Strömma kommer livetexten tillbaka för den nya delen.
Innan en del når flödets största filstorlek startar nästa del på samma
mikrofon. Marginalen räknas från bithastigheten och chunkintervallet, och de två
delarna spelar in samtidigt i 150 ms, eftersom Chrome tappar de sista
millisekunderna före ett stopp. När flödets sista fil (`max_files`) är full
stoppas inspelningen med ett meddelande, och allt som spelats in finns kvar.
Återstående inspelningstid finns i inspelarens tillstånd (`remainingMs`). En del
som inte fick något ljud räknas inte som fil. Delarna skickas i ordning som
filer i samma körning (`file_ids`), med inspelningens egen idempotensnyckel, så
att Eneo gör en körning per inspelning även om två flikar skickar den.

En inspelning används av en flik i taget: den flik som spelar in den, skickar
den eller tar bort den håller ett lås (Web Locks) som webbläsaren släpper när
fliken stängs eller kraschar. Andra flikar visar den inte som osänd så länge,
och **Skicka** eller **Ta bort** där nekas med ett meddelande. Utan Web Locks
(Safari före 15.4) kan bara fliken som spelade in en inspelning skicka,
fortsätta eller ta bort den; andra flikar, och samma flik efter en omladdning,
kan spara den som fil.

Inspelaren spelar in tal i mono med 32 kbit/s, med Opus när webbläsaren kan och
annars webbläsarens eget format (Safari: `audio/mp4`). Ett möte på fem timmar
blir då ungefär 72 MB. Chromes WebM-filer saknar längd i sitt huvud; när en del
sätts ihop till en fil skrivs den inspelade längden dit, så att uppspelningen
visar rätt längd och går att spola i.

Uppladdning och start av körning försöker igen vid nätverksfel, 408, 429 och
5xx, med en väntetid som börjar på 1 s och fördubblas upp till 60 s, och direkt
när anslutningen är tillbaka. Körningen startas med samma idempotensnyckel vid
varje försök. Andra 4xx-fel stoppar med Eneos felmeddelande.

### Strömma: live-text medan man spelar in

Strömma visar texten medan användaren spelar in. Den är en förhandsvisning:
inspelningen laddas upp och flödet körs som i Spela in, och körningens
transkript är det som gäller. Run-kontraktets `transcription.live` säger i
förväg om flödets ljudsteg kan visa live-text.

Browsern öppnar en WebSocket till `/api/live/{flowId}/{stepId}` på modulens
egen origin, skickar mono PCM16 LE i 16 kHz som binära ramar och till sist
`{"type":"stop"}`. Modulens backend:

1. släpper bara in en inloggad användare vars `Origin` är `MODULE_PUBLIC_URL`
   (handshaken är en GET men kontrolleras som en mutation) och stänger annars
   med 1008 innan anslutningen accepteras;
2. begär en engångsticket med `POST /api/v1/flows/{flowId}/steps/{stepId}/live-transcription-sessions/`
   och samma dubbla credentials som övriga Flow-anrop, efter att ha förnyat
   modultoken om det är dags;
3. öppnar Eneos WebSocket server-side med ticketen som subprotokoll och utan
   browserns `Origin`; ticketen når aldrig browsern;
4. skickar ramar och `stop` oförändrade till Eneo, och Eneos JSON-händelser
   (`ready`, `transcript.delta`, `transcript.done`, `error`) oförändrade
   tillbaka. Stänger ena sidan stänger backend den andra.

Nekar Eneo ticketen, till exempel 409 `flow_live_transcription_unavailable`,
får browsern en enda `error`-händelse med Eneos `code` och sedan en normal
stängning. Når backend inte Eneo blir koden `upstream_unreachable` med
`retryable: true`.

Varje startsätt för backend (imagen, backend-imagen och dev-kommandot ovan)
tar emot högst 128 KiB per WebSocket-meddelande och 16 meddelanden i kö, så en
anslutning buffrar högst 2 MiB innan Eneo ser ramarna. Ett test kräver att
startsätten har samma gränser. Går en av sidorna inte att skriva till på 15
sekunder avslutar backend sessionen.

Ingen ny miljövariabel behövs. Next proxar WebSocket-uppgraderingen genom samma
`/api/*`-rewrite som övriga anrop, i `next dev`, i den fristående servern och i
produktionsimagen; Traefik släpper igenom den utan extra konfiguration
(verifierat med Next 16.3.4 och Traefik 3.7, även en anslutning utan ljud i 90
sekunder). Går `ENEO_BACKEND_URL` via en proxy måste den också släppa igenom
WebSocket-uppgraderingar till Eneo.
