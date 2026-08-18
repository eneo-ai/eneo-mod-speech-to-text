# Eneo Speech-to-Text Module

Lyssna är en Eneo-modul som låter en inloggad användare spela in samtal i browsern, skicka det till ett publicerat Eneo-flöde, och visa resultatet (transkript + sammanfattning + ev. genererade filer).

```
Browser  →  Next.js (3000 dev / 3001 prod)  →  FastAPI (intern, port 8000)
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
# (samt valfri DEMO_SPACE_ID).
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
2. Kör **Dev Containers: Reopen in Container**.
3. Skapa lokal miljöfil om den saknas:

```bash
cp .env.example .env
```

4. Fyll i `.env`. För lokal körning i devcontainern behöver `COOKIE_SECURE=false`.
5. Starta backend i en terminal:

```bash
set -a
source .env
set +a
cd backend
source .venv/bin/activate
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

6. Starta frontend i en annan terminal:

```bash
cd frontend
INTERNAL_API_BASE=http://127.0.0.1:8000 npm run dev
```

Öppna sedan `http://localhost:3000`. VS Code forwardar port `3000` och `8000`.

Tester:

```bash
cd frontend && npm ci && npm test && npm run build
cd ../backend && .venv/bin/python -m unittest discover -s tests
cd .. && docker compose --env-file .env.example config -q
docker build -t eneo-mod-speech-to-text:test .
```

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

Callbacken redirectar alltid till en ren URL och returnerar `Referrer-Policy: no-referrer`. Backendens Uvicorn-accesslogg är avstängd så att callbackens ticket och state inte hamnar i containerloggar. Ingress-/Traefik-loggning måste också exkludera callbackens query string.

> Denna modulimplementation förutsätter Eneos stabila `module_key`-kontrakt, frontend-route `/module-login` och Flow-resurser som kräver både service key och module-user-token.

### Tillfällig åtkomstkod (`AUTH_MODE=access_code`)

Detta läge finns endast för fristående test innan hela SSO-handoffen är deployad. Sätt `APP_ACCESS_CODE` som en Dokploy-secret med 16–256 tecken; generera den exempelvis med `python -c "import secrets; print(secrets.token_urlsafe(24))"` och rotera den vid behov. Koden jämförs i konstant tid i backend, skickas aldrig i URL:en och persisteras inte av applikationen. Vid lyckad login skapas samma sorts slumpmässiga, opaka HttpOnly-session som i SSO-läget.

Begränsningar:

- åtkomstkoden är en delad grind, inte en användaridentitet; den ger ingen per-person- eller tenant-audit;
- `ENEO_API_KEY` är fortfarande obligatorisk och används för anrop till Eneo;
- upstream-anrop skickar endast service key, aldrig en påhittad Bearer-token;
- när Eneo kräver både service key och module-user-token kommer Flow-anrop därför att nekas;
- sessionslagret är processlokalt, sessionen löper ut efter högst en timme och försvinner vid omstart;
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
   | `DEMO_SPACE_ID` | (valfritt) UUID för space; skippar space-väljaren |
   | `DEMO_SPACE_NAME` | (valfritt) visningsnamn för det space:t |
   | `UPLOAD_PROXY_TIMEOUT_SECONDS` | (valfritt) timeout för backendens upload-forwarding till Eneo, default `1800` |

3. **Konfigurera domänen** `transkribering.sundsvall.dev` i Dokploy och peka mot tjänsten `frontend` (port 3000). Dokploy/Traefik sköter HTTPS-certifikatet.

4. **Deploy.** Dokploy bygger båda containrarna via `docker-compose.yml`. Backend exponeras inte externt — bara internt mot `frontend` på `http://speech-to-text-backend:8000`. Det unika tjänstenamnet undviker DNS-kollision med Eneos egen backend på Dokploys gemensamma nätverk.

5. **Verifiera** efter deploy:
   - `https://transkribering.sundsvall.dev/` → Eneo-login eller kodformulär enligt `AUTH_MODE`
   - `https://transkribering.sundsvall.dev/api/healthz` → `{"ok":true}`
   - `eneo_sso`: callback-URL:en blir ren efter lyckad login
   - båda lägen: flödeslistan visas och ett riktigt Flow-anrop lyckas

### Vid problem

- **Backend kraschar vid start:** kontrollera basvariablerna samt `ENEO_PUBLIC_URL` i SSO-läge eller `APP_ACCESS_CODE` i kodläge. `ENEO_API_KEY` krävs i båda.
- **Login misslyckas efter callback:** kontrollera exakt registrerad callback-URL, module key, bunden service key och att `COOKIE_SECURE=true` endast används bakom HTTPS.
- **Kodlogin fungerar men Flow-anrop nekas:** Eneo-routen kräver sannolikt module-user-token; byt till `eneo_sso` när handoff-kontraktet är deployat.
- **502 vid uppladdning:** Eneo-load-balancer-problem; kolla `docker compose logs backend` för exakt httpx-fel.
- **504 vid uppladdning:** backendens upload-forwarding till Eneo tog längre än `UPLOAD_PROXY_TIMEOUT_SECONDS`.
- **Tom flödeslista:** API-nyckeln har inget space scope, eller `DEMO_SPACE_ID` pekar på fel space.

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

Browsern ska inte använda en hårdkodad 120-sekunders timeout för stora ljudfiler.
Klienten räknar i stället upload-timeout från `runtime_upload_policy` i
flow-kontraktet och håller uppladdningen vid liv så länge progress fortsätter.

Inspelaren använder komprimerat browserformat, i första hand WebM/Opus när
flödet accepterar det, och ber `MediaRecorder` om korta chunks under inspelning.
Det minskar risken att långa möten bygger upp en enda stor intern recorder-buffer.
Det är fortfarande inte live-streaming till Eneo: Eneo-körningen startar när hela
ljudfilen har laddats upp och ett `file_id` finns.
