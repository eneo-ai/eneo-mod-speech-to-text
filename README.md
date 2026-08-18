# Eneo Speech-to-Text Module

Lyssna är en Eneo-modul som låter en inloggad användare spela in samtal i browsern, skicka det till ett publicerat Eneo-flöde, och visa resultatet (transkript + sammanfattning + ev. genererade filer).

```
Browser  →  Next.js (3000 dev / 3001 prod)  →  FastAPI (intern, port 8000)
                │                         │
                UI               module session + BFF proxy
                                          │
                                          └──service key + user token──→  Eneo
```

Eneos API-nyckel stannar i backendprocessen. Module-user-token ligger endast i en signerad HttpOnly-session och returneras aldrig till frontend-JavaScript. Frontend pratar endast same-origin via Next.js rewrite.

Produktionsimagen `ghcr.io/eneo-ai/eneo-mod-speech-to-text` paketerar båda processerna i en isolerad modulcontainer på port 3001. Supervisor övervakar och startar om processerna vid oväntade fel; imagen har dessutom ett healthcheck genom hela Next→FastAPI-kedjan. Den befintliga tvåcontainer-Compose-filen är avsedd för lokal utveckling.

---

## Local development

```bash
cp .env.example .env
# Fyll i Eneo/module-URL:er, ENEO_API_KEY och SESSION_SECRET
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

## Inloggning via Eneo

Modulen är ingen egen OIDC-klient. Eneo förblir installationens enda autentiseringsauktoritet.

Flödet:

1. `GET /api/auth/login` skapar ett oförutsägbart, kortlivat `state`, binder det till en HttpOnly-cookie och skickar browsern till Eneos `/module-login` med `module_key=speech-to-text`.
2. Eneo autentiserar användaren och skickar tillbaka en engångsticket till `/api/auth/callback`.
3. Callbacken verifierar och förbrukar `state`, växlar ticket server-side med modulens registrerade service key och skapar en HttpOnly-modulsession.
4. Varje proxat Eneo-anrop skickar både modulens service key och den kortlivade module-user-token som BFF:en hämtar ur sessionen.

Callbacken redirectar alltid till en ren URL och returnerar `Referrer-Policy: no-referrer`. Backendens Uvicorn-accesslogg är avstängd så att callbackens ticket och state inte hamnar i containerloggar. Ingress-/Traefik-loggning måste också exkludera callbackens query string.

> Denna modulimplementation förutsätter Eneos stabila `module_key`-kontrakt, frontend-route `/module-login` och Flow-resurser som kräver både service key och module-user-token.

### Kontrakt mot Eneos modul-overlay

Produktionsimagen exponerar port `3001` och healthcheck på `/health`. Eneos Compose-overlay ska ge tjänsten endast `module_net` och skicka följande canonical env-namn:

- `ENEO_BACKEND_URL=http://backend:8000`
- `ENEO_PUBLIC_URL=https://<eneo-domain>`
- `MODULE_PUBLIC_URL=https://<module-domain>`
- `MODULE_KEY=speech-to-text`
- `ENEO_API_KEY=<module-specific sk_ key>`
- `SESSION_SECRET=<random 32+ characters>`

Äldre exempelvärden som `MODULE_ID` och `TAL_TILL_TEXT_API_KEY` läses medvetet inte av imagen. Overlay-filen ska mappa operatörens secret till `ENEO_API_KEY`; då finns ett canonical konfigurationskontrakt i modulprocessen.

---

## Deploy på Dokploy (`transkribering.sundsvall.dev`)

1. **Skapa Compose-projekt i Dokploy** och peka på det här repot.

2. **Sätt environment variables** i Dokploy-UI:t (motsvarande `.env`):

   | Variabel | Värde |
   |---|---|
   | `ENEO_BACKEND_URL` | `http://backend:8000` på Eneos `module_net` |
   | `ENEO_PUBLIC_URL` | `https://flow.sundsvall.dev` |
   | `MODULE_PUBLIC_URL` | `https://transkribering.sundsvall.dev` |
   | `MODULE_KEY` | `speech-to-text` |
   | `ENEO_API_KEY` | en `sk_…`-nyckel från Eneo med rätt space-scope |
   | `SESSION_SECRET` | minst 32 tecken slumpmässigt (se ovan) |
   | `COOKIE_SECURE` | `true` |
   | `DEMO_SPACE_ID` | (valfritt) UUID för space; skippar space-väljaren |
   | `DEMO_SPACE_NAME` | (valfritt) visningsnamn för det space:t |
   | `UPLOAD_PROXY_TIMEOUT_SECONDS` | (valfritt) timeout för backendens upload-forwarding till Eneo, default `1800` |

3. **Konfigurera domänen** `transkribering.sundsvall.dev` i Dokploy och peka mot tjänsten `frontend` (port 3000). Dokploy/Traefik sköter HTTPS-certifikatet.

4. **Deploy.** Dokploy bygger båda containrarna via `docker-compose.yml`. Backend exponeras inte externt — bara internt mot `frontend` på `http://backend:8000`.

5. **Verifiera** efter deploy:
   - `https://transkribering.sundsvall.dev/` → login via Eneo
   - `https://transkribering.sundsvall.dev/api/healthz` → `{"ok":true}`
   - Callback-URL:en blir ren efter lyckad login och flödeslistan visas

### Vid problem

- **Backend kraschar vid start:** kontrollera att samtliga URL:er, `MODULE_KEY`, `ENEO_API_KEY` och `SESSION_SECRET` är satta.
- **Login misslyckas efter callback:** kontrollera exakt registrerad callback-URL, module key, bunden service key och att `COOKIE_SECURE=true` endast används bakom HTTPS.
- **502 vid uppladdning:** Eneo-load-balancer-problem; kolla `docker compose logs backend` för exakt httpx-fel.
- **504 vid uppladdning:** backendens upload-forwarding till Eneo tog längre än `UPLOAD_PROXY_TIMEOUT_SECONDS`.
- **Tom flödeslista:** API-nyckeln har inget space scope, eller `DEMO_SPACE_ID` pekar på fel space.

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
