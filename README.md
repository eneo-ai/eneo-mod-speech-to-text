# Eneo Speech-to-Text Module

Lyssna är en webbapp som låter en åtkomstkod-skyddad användare spela in samtal i browsern, skicka det till ett publicerat Eneo-flöde, och visa resultatet (transkript + sammanfattning + ev. genererade filer).

```
Browser  →  Next.js (port 3000)  →  FastAPI (intern, port 8000)
                │                         │
                UI                  cookie-auth + proxy
                                          │
                                          └──X-API-Key──→  Eneo
```

Eneos API-nyckel lever bara i backend-containern och lämnar den aldrig till browsern. Frontend pratar bara same-origin via Next.js rewrite.

---

## Local development

```bash
cp .env.example .env
# Fyll i ENEO_API_KEY, APP_ACCESS_CODE, SESSION_SECRET (samt valfri DEMO_SPACE_ID).
# Sätt COOKIE_SECURE=false för lokal http://localhost.

docker compose up --build
open http://localhost:3000
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
docker run --rm -v "$PWD/frontend/lib:/app/lib:ro" transkribering-frontend npm run test
docker run --rm -v "$PWD/backend/app:/app/app:ro" -v "$PWD/backend/tests:/app/tests:ro" \
  -e ENEO_API_BASE=https://eneo.example.test \
  -e ENEO_API_KEY=test-key \
  -e APP_ACCESS_CODE=test-code \
  -e SESSION_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  transkribering-backend python -m unittest discover -s tests
```

---

## Åtkomstkod (gate)

Hela appen är skyddad bakom **`APP_ACCESS_CODE`**. Backend kräver den vid start och fail-fast:ar om den saknas eller är kortare än 4 tecken.

Flödet:

1. Användaren kommer till `/`, möts av en login-vy och uppmanas ange koden.
2. Backend (`POST /api/auth/login`) jämför mot `APP_ACCESS_CODE` och sätter en signerad, HTTP-only session-cookie (8 h TTL, signerad med `SESSION_SECRET` via `itsdangerous`).
3. Alla anrop mot Eneo går genom `/api/eneo/{path}` som kräver giltig cookie. Saknas den får man 401 och kastas tillbaka till login.

> **Byt kod efter behov:** ändra `APP_ACCESS_CODE` i `.env`/Dokploy-env och starta om backend. Aktiva sessioner förblir giltiga tills cookie-TTL går ut — för att även invalidera dem, byt `SESSION_SECRET`.

---

## Deploy på Dokploy (`transkribering.sundsvall.dev`)

1. **Skapa Compose-projekt i Dokploy** och peka på det här repot.

2. **Sätt environment variables** i Dokploy-UI:t (motsvarande `.env`):

   | Variabel | Värde |
   |---|---|
   | `ENEO_API_BASE` | `https://flow.sundsvall.dev` |
   | `ENEO_API_KEY` | en `sk_…`-nyckel från Eneo med rätt space-scope |
   | `APP_ACCESS_CODE` | det användarna ska skriva in |
   | `SESSION_SECRET` | minst 32 tecken slumpmässigt (se ovan) |
   | `COOKIE_SECURE` | `true` |
   | `DEMO_SPACE_ID` | (valfritt) UUID för space; skippar space-väljaren |
   | `DEMO_SPACE_NAME` | (valfritt) visningsnamn för det space:t |
   | `UPLOAD_PROXY_TIMEOUT_SECONDS` | (valfritt) timeout för backendens upload-forwarding till Eneo, default `1800` |

3. **Konfigurera domänen** `transkribering.sundsvall.dev` i Dokploy och peka mot tjänsten `frontend` (port 3000). Dokploy/Traefik sköter HTTPS-certifikatet.

4. **Deploy.** Dokploy bygger båda containrarna via `docker-compose.yml`. Backend exponeras inte externt — bara internt mot `frontend` på `http://backend:8000`.

5. **Verifiera** efter deploy:
   - `https://transkribering.sundsvall.dev/` → login-vy
   - `https://transkribering.sundsvall.dev/api/healthz` → `{"ok":true}`
   - Logga in med `APP_ACCESS_CODE` → flödeslistan ska visas

### Vid problem

- **Backend kraschar vid start:** kontrollera Dokploy-loggen — sannolikt saknad/för kort `APP_ACCESS_CODE` eller `SESSION_SECRET`.
- **Login lyckas men man kastas direkt tillbaka:** `COOKIE_SECURE=true` men sajten serveras över HTTP. Sätt antingen `COOKIE_SECURE=false` (osäkert) eller fixa HTTPS.
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
