# Lokal utveckling

Syfte: Visa hur man startar modulen lokalt, med Docker, i devcontainern eller mot en stubbackend, och vilka portar som används.

Läs detta när: Du sätter upp en utvecklingsmiljö, ska köra appen mot ett lokalt Eneo, eller behöver se en skärm utan Eneo.

Hör ihop med: [Drift](operations.md), [Kvalitetsgrindar](quality-gates.md), [Backend](backend.md#inställningar), [Frontend](frontend.md)

## Portar

| Port | Vad |
|---|---|
| 3000 | Compose: `frontend`-tjänsten (`docker-compose.override.yml` publicerar den lokalt). |
| 3001 | Produktionsimagen: allt i en container. |
| 3002 | `npm run dev` (Next.js utvecklingsserver). |
| 8000 | Backend (FastAPI), internt. |
| 3401 och 8401 | Tillgänglighetsgrinden och `npm run dev:stub`: app och stubbackend. |
| 3411 och 8411 | `npm run test:prod`: byggd app och stubbackend. |

Dev-servern lyssnar avsiktligt på 3002: Eneos egen devcontainer tar 3000 (webb) och 8123 (API), och båda körs ofta samtidigt. Grindens portar kan flyttas med `A11Y_APP_PORT` och `A11Y_STUB_PORT`, se [Kvalitetsgrindar](quality-gates.md#portar-och-flera-utcheckningar).

## Med Docker Compose

Från repots rot:

```bash
cp .env.example .env
# Fyll i auth-läge, Eneo- och modul-URL:er, ENEO_API_KEY och SESSION_SECRET
# (samt DEMO_SPACE_ID i access_code-läget). Sätt COOKIE_SECURE=false för lokal http://localhost.
docker compose up --build
open http://localhost:3000
```

Generera `SESSION_SECRET` (minst 32 tecken) med:

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Följ loggarna (tjänsterna heter `speech-to-text-backend` och `frontend`):

```bash
docker compose logs -f speech-to-text-backend
docker compose logs -f frontend
```

### Verifiera produktionsimagen lokalt

```bash
docker build -t eneo-mod-speech-to-text:test .
docker run --rm --env-file .env -p 3001:3001 eneo-mod-speech-to-text:test
curl -fsS http://localhost:3001/health
```

Validera Compose-konfigurationen utan att starta något:

```bash
docker compose --env-file .env.example config -q
```

## Utan Docker: devcontainer

Projektet har en devcontainer med Python 3.12 och Node 22 (`.devcontainer/devcontainer.json`). Frontend kräver Node 22.22.2 eller senare (`engines` i `frontend/package.json`: react-router 8.4 kräver 22.22 och jsdom 30, som enhetstesterna kör, 22.22.2); devcontainern, CI och imagen hämtar senaste 22.x, så bygg om en äldre devcontainer.

1. Öppna repot i VS Code.
2. Kör **Dev Containers: Reopen in Container** och öppna en **ny terminal i det VS Code-fönstret**. Kommandona nedan ska köras inne i containern, där repot ligger på `/workspaces/eneo-mod-speech-to-text`.
3. Skapa miljöfilen om den saknas: `cp .env.example .env`.
4. Fyll i `.env`. För lokal körning i devcontainern behövs `COOKIE_SECURE=false`.
5. Starta backend i en terminal inne i containern:

```bash
cd /workspaces/eneo-mod-speech-to-text
set -a
source .env
set +a
cd backend
.venv/bin/python -m app.serve --api-only --host 0.0.0.0 --port 8000 --reload
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

Starta om frontend efter att ha ändrat `NEXT_PUBLIC_`-inställningar. Öppna sedan `http://localhost:3002`; VS Code vidarebefordrar portarna 3002 och 8000.

I `next dev` proxas `/api` automatiskt till `http://127.0.0.1:8000`. Sätt `INTERNAL_API_BASE` om backend körs någon annanstans (`frontend/lib/backend-base.mjs`).

Backendens startkommando ovan har samma WebSocket-gränser som produktionsimagen, och `backend/tests/test_live_relay.py` kontrollerar det genom att läsa raden i [README](../README.md). Ändra dem tillsammans.

Om du får `uvicorn: command not found` efter att ha aktiverat `.venv`: kontrollera att terminalen verkligen är inne i containern. Miljön skapas där med Python 3.12; den kan inte användas från macOS även om prompten visar `(.venv)`. Från en vanlig terminal på datorn kan du gå in med `docker exec -it <containerns namn> bash` (hitta namnet med `docker ps`) och sedan köra startkommandona ovan.

### Mot ett lokalt Eneo

Mot ett lokalt Eneo i devcontainer:

| Variabel | Värde |
|---|---|
| `ENEO_BACKEND_URL` | `http://host.docker.internal:8123` |
| `ENEO_PUBLIC_URL` | `http://localhost:3000` |
| `MODULE_PUBLIC_URL` | `http://localhost:3002` |
| `COOKIE_SECURE` | `false` |

Snabbaste vägen är `AUTH_MODE=access_code` med en `sk_`-nyckel (service, `flows = write`) skapad i Eneos admin. För riktig SSO installeras modulen i Eneo med callback `http://localhost:3002/api/auth/callback`.

## Se en skärm utan Eneo

Stubbackenden `frontend/tests/e2e/stub-server.py` (bara för test, skeppas aldrig) låtsas vara modulens backend och Eneo, så att varje skärm går att nå. Från `frontend/`:

```bash
npm run dev:stub
```

Det startar stubben och appen på `http://127.0.0.1:3401`. Med andra portar: `A11Y_APP_PORT=3464 A11Y_STUB_PORT=8464 npm run dev:stub`.

Vissa lägen går inte att nå med en vanlig adress eftersom de behöver Playwrights nätverksavlyssning eller klocka. Öppna ett namngivet läge ur `frontend/tests/e2e/screens.ts` i en webbläsare med fönster:

```bash
npm run state -- "<läge>"
```

Skärmbilder per läge och projekt: se [Kvalitetsgrindar](quality-gates.md#läsa-ett-fel).

## Designsystemets kommandon

Alla går från `frontend/` och körs alltid via `npm run astryx --`, så att den fastlåsta versionen används: `build "<idé>"`, `component <Namn>`, `template <namn>`, `docs <ämne>`, `search "<fråga>"`, `doctor`. Se [Designsystem](design-system.md).
