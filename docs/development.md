# Lokal utveckling

## Portar

| Port | Vad |
|---|---|
| 3001 | Modulen: den publicerade imagen, eller den lokala med `docker compose up --build`. |
| 3002 | `npm run dev`: Vites utvecklingsserver, som vidarebefordrar `/api` och `/health` till backend. |
| 8000 | Backend i utveckling (`--api-only`, alltså utan gränssnitt). |
| 3401 och 8401 | Gaten och `npm run dev:stub`: app och stubbackend. |
| 3411 till 3413 och 8411 | `npm run test:prod`: tre riktiga backends med varsitt bygge, och stubben som Eneo. |
| 8480 till 8482 | `npm run test:image`: Traefik, stubben som Eneo och imagens egen port. |

Utvecklingsservern ligger på 3002 för att Eneos egen devcontainer tar 3000 (webb) och 8123 (API), och båda körs ofta samtidigt. Gatens och testernas portar flyttas med `A11Y_APP_PORT` och `A11Y_STUB_PORT` ([Tester](quality-gates.md#portar-och-flera-utcheckningar)).

## Med Docker

Från repots rot bygger `docker compose up --build` imagen lokalt (`docker-compose.override.yml`) och publicerar port 3001:

```bash
cp .env.example .env
# Fyll i ENEO_BACKEND_URL, ENEO_PUBLIC_URL, ENEO_API_KEY och SESSION_SECRET. För lokal körning:
# MODULE_PUBLIC_URL=http://localhost:3001 och COOKIE_SECURE=false (http godtas bara för localhost, 127.0.0.1 och [::1]).
docker compose up --build
open http://localhost:3001
```

`SESSION_SECRET` (minst 32 tecken): `python -c "import secrets; print(secrets.token_urlsafe(48))"`. Loggar: `docker compose logs -f speech-to-text`. Granskningen av transkriptet slås på när imagen byggs: `SPEAKER_REVIEW_ENABLED=true` i `.env`.

Imagen utan Compose:

```bash
docker build -t eneo-mod-speech-to-text:test .
docker run --rm --env-file .env -p 3001:3001 eneo-mod-speech-to-text:test
curl -fsS http://localhost:3001/health
```

## Utan Docker

Backend och Vite körs var för sig. Devcontainern (`.devcontainer/devcontainer.json`) har Python 3.12 och Node 22; frontend kräver Node 22.22.2 eller senare (`engines` i `frontend/package.json`). Miljön i `backend/.venv` skapas i devcontainern (`.devcontainer/post-create.sh`) eller med `python -m venv .venv && .venv/bin/pip install -r requirements.txt`. Läs in `.env` i båda terminalerna, med `COOKIE_SECURE=false` och `MODULE_PUBLIC_URL=http://localhost:3002`:

```bash
# Backend (från backend/): utan gränssnitt, startar om vid kodändringar
set -a; source ../.env; set +a
.venv/bin/python -m app.serve --api-only --host 0.0.0.0 --port 8000 --reload
```

```bash
# Frontend (från frontend/): Vite på http://localhost:3002
set -a; source ../.env; set +a
npm run dev
```

Vite vidarebefordrar `/api` (också WebSocket, som live-texten använder) och `/health` till `DEV_API_BASE` (standard `http://127.0.0.1:8000`) med webbläsarens `Origin` oförändrad, vilket är varför `MODULE_PUBLIC_URL` ska vara `http://localhost:3002`. `--api-only` behövs eftersom starten annars vägrar utan ett byggt gränssnitt. `SPEAKER_REVIEW_ENABLED=true` i miljön slår på granskningen; starta om Vite efter en ändring.

### Mot ett lokalt Eneo

| Variabel | Värde |
|---|---|
| `ENEO_BACKEND_URL` | `http://host.docker.internal:8123` |
| `ENEO_PUBLIC_URL` | `http://localhost:3000` |
| `MODULE_PUBLIC_URL` | `http://localhost:3002` |
| `COOKIE_SECURE` | `false` |

Modulen installeras i Eneo med callback `http://localhost:3002/api/auth/callback`, och servicenyckeln (`sk_`, service, `flows = write`) skapas i Eneos admin.

### Den riktiga backenden utan ett Eneo

Stubben `frontend/tests/e2e/stub-server.py` (bara för test) kan spela Eneo, inloggningen (`/module-login`) inräknad. Från repots rot, i tre terminaler:

```bash
# 1. Stubben som Eneo
cd frontend && python3 tests/e2e/stub-server.py 8401

# 2. Backend, som loggar in genom stubben
cd backend
ENEO_BACKEND_URL=http://127.0.0.1:8401 ENEO_PUBLIC_URL=http://127.0.0.1:8401 \
MODULE_PUBLIC_URL=http://localhost:3002 MODULE_KEY=speech-to-text ENEO_API_KEY=stub-service-key \
SESSION_SECRET=$(python3 -c "import secrets; print(secrets.token_urlsafe(48))") COOKIE_SECURE=false \
.venv/bin/python -m app.serve --api-only --port 8000 --reload

# 3. Vite-servern
cd frontend && npm run dev
```

Öppna `http://localhost:3002` och välj "Logga in med Eneo": stubben loggar in Erik Lund. Stubbens flöden, körningar och filer är de som gaten använder.

## Se en skärm utan Eneo

Stubben kan också vara modulens backend, så att varje skärm går att nå utan Eneo och utan backend. Från `frontend/`:

```bash
npm run dev:stub
```

Det startar stubben och appen på `http://127.0.0.1:3401` (andra portar: `A11Y_APP_PORT=3464 A11Y_STUB_PORT=8464 npm run dev:stub`). Vissa lägen går inte att nå med en vanlig adress eftersom de behöver Playwrights nätverksavlyssning eller klocka: öppna ett namngivet läge ur `frontend/tests/e2e/screens.ts` i en webbläsare med fönster med `npm run state -- "<läge>"`.
