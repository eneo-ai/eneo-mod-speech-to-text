# Lokal utveckling

Syfte: Visa hur man startar modulen lokalt, med Docker, i devcontainern eller mot en stubbackend, och vilka portar som används.

Läs detta när: Du sätter upp en utvecklingsmiljö, ska köra appen mot ett lokalt Eneo, eller behöver se en skärm utan Eneo.

Hör ihop med: [Drift](operations.md), [Kvalitetsgrindar](quality-gates.md), [Backend](backend.md#inställningar), [Frontend](frontend.md)

## Portar

| Port | Vad |
|---|---|
| 3000 | Compose: `frontend`-tjänsten (`docker-compose.override.yml` publicerar den lokalt). |
| 3001 | Produktionsimagen: allt i en container. |
| 3002 | `npm run dev` (Vite-utvecklingsserver, som vidarebefordrar `/api` och `/health` till backend på 8000). |
| 8000 | Backend (FastAPI), internt; i utveckling med `--api-only`, alltså utan gränssnitt. |
| 3401 och 8401 | Tillgänglighetsgrinden och `npm run dev:stub`: app och stubbackend. |
| 3411 till 3413 och 8411 | `npm run test:prod`: tre riktiga backends med varsitt bygge, och stubben som Eneo. |

Dev-servern lyssnar avsiktligt på 3002: Eneos egen devcontainer tar 3000 (webb) och 8123 (API), och båda körs ofta samtidigt. Grindens portar kan flyttas med `A11Y_APP_PORT` och `A11Y_STUB_PORT`, se [Kvalitetsgrindar](quality-gates.md#portar-och-flera-utcheckningar).

## Med Docker Compose

Från repots rot:

```bash
cp .env.example .env
# Fyll i Eneo- och modul-URL:er, ENEO_API_KEY och SESSION_SECRET. Sätt COOKIE_SECURE=false och en http-adress
# för MODULE_PUBLIC_URL bara för lokal http://localhost: backend stoppar starten för alla andra värdar.
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

6. Starta frontend i en annan terminal inne i containern. Läs in `.env` även här; byggkonstanten `SPEAKER_REVIEW_ENABLED=true` slår på granskningen (`frontend/vite.config.mts`):

```bash
cd /workspaces/eneo-mod-speech-to-text
set -a
source .env
set +a
cd frontend
npm run dev
```

Starta om dev-servern efter att ha ändrat `SPEAKER_REVIEW_ENABLED`. Öppna sedan `http://localhost:3002`; VS Code vidarebefordrar portarna 3002 och 8000.

Vite-servern vidarebefordrar `/api` (också WebSocket, som live-texten använder) och `/health` till backend på `http://127.0.0.1:8000`. Sätt `DEV_API_BASE` om backend körs någon annanstans (`frontend/vite.config.mts`). Webbläsarens `Origin` går oförändrad till backend, vars kontroll av den kräver att `MODULE_PUBLIC_URL` är `http://localhost:3002`. Flaggan `--api-only` behövs eftersom startprogrammet annars vägrar starta utan ett byggt gränssnitt (`STATIC_DIR`); Vite visar sidorna.

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

Inloggningen är Eneo SSO: modulen installeras i Eneo med callback `http://localhost:3002/api/auth/callback`, och servicenyckeln (`sk_`, service, `flows = write`) skapas i Eneos admin. `http` godtas för de två publika adresserna och `COOKIE_SECURE=false` bara när värden är `localhost`, `127.0.0.1` eller `[::1]`.

## Den riktiga backenden utan ett Eneo

Stubben kan också spela Eneo, inloggningen (`/module-login`) inräknad, så att den riktiga backenden och Vite-servern går att köra utan ett Eneo. Från repots rot, i tre terminaler:

```bash
# 1. Stubben som Eneo
cd frontend && python3 tests/e2e/stub-server.py 8401

# 2. Backend, som loggar in genom stubben
cd backend
ENEO_BACKEND_URL=http://127.0.0.1:8401 ENEO_PUBLIC_URL=http://127.0.0.1:8401 \
MODULE_PUBLIC_URL=http://localhost:3002 MODULE_KEY=speech-to-text ENEO_API_KEY=stub-service-key \
SESSION_SECRET=$(python3 -c "import secrets; print(secrets.token_urlsafe(48))") COOKIE_SECURE=false \
.venv/bin/python -m app.serve --api-only --port 8000 --reload

# 3. Vite-servern, som vidarebefordrar /api till backend
cd frontend && npm run dev
```

Öppna `http://localhost:3002` och välj "Logga in med Eneo": stubben loggar in Erik Lund. Det är samma inloggning som i produktion, steg för steg, och stubbens flöden, körningar och filer är de som grinden använder.

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
