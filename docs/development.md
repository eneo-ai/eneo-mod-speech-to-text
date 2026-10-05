# Lokal utveckling

## Kom igång

1. **Du behöver ett Eneo som modulen når**, med en servicenyckel och modulen installerad ([Sätt upp modulen i Eneo](operations.md#sätt-upp-modulen-i-eneo)). Har du inget kör du stubben som Eneo i stället ([utan Eneo](#den-riktiga-backenden-utan-ett-eneo)).
2. **Hämta koden och inställningarna:**

   ```bash
   git clone https://github.com/eneo-ai/eneo-mod-speech-to-text && cd eneo-mod-speech-to-text
   cp .env.example .env
   ```

3. **Fyll i `.env`:** `ENEO_BACKEND_URL`, `ENEO_PUBLIC_URL`, `ENEO_API_KEY` och `SESSION_SECRET` (skapa den med `python -c "import secrets; print(secrets.token_urlsafe(48))"`). För lokal körning också `MODULE_PUBLIC_URL=http://localhost:3001` och `COOKIE_SECURE=false`. Kör Eneo på din egen dator, på port 8123 för API:t och 3000 för webben, är `ENEO_BACKEND_URL=http://host.docker.internal:8123` (så når containern din dator) och `ENEO_PUBLIC_URL=http://localhost:3000` (så når webbläsaren den).
4. **Starta:** `docker compose up --build`
5. **Öppna** `http://localhost:3001` i webbläsaren.

Mikrofonen fungerar på `localhost` men kräver HTTPS på en annan adress ([Drift](operations.md#vad-som-står-framför-modulen)).

## Portar

| Port | Vad |
|---|---|
| 3001 | Modulen: den publicerade imagen, eller den lokala med `docker compose up --build`. |
| 3002 | `npm run dev`: Vites utvecklingsserver, som vidarebefordrar `/api` och `/health` till backend. |
| 8000 | Backend i utveckling (`--api-only`, alltså utan gränssnitt). |
| 3401 och 8401 | Gaten och `npm run dev:stub`: app och stubbackend. |

Utvecklingsservern ligger på 3002 för att Eneos egen devcontainer tar 3000 (webb) och 8123 (API), och båda körs ofta samtidigt. Testernas övriga portar och hur de flyttas: [Tester](quality-gates.md#portar-och-flera-utcheckningar).

## Med Docker

`docker compose up --build` bygger imagen lokalt (`docker-compose.override.yml`) och publicerar port 3001. `SESSION_SECRET` är minst 32 tecken: `python -c "import secrets; print(secrets.token_urlsafe(48))"`. Loggar: `docker compose logs -f speech-to-text`. Granskningen av transkriptet slås på när imagen byggs: `SPEAKER_REVIEW_ENABLED=true` i `.env`.

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

Eneos egen devcontainer lägger webben på port 3000 och API:t på 8123. Vem som når vad bestämmer adressen: en modul i Docker når din dator som `host.docker.internal`, en modul som körs direkt gör det som `localhost`, och webbläsaren når alltid Eneos webb på `localhost`.

| Variabel | Modulen i Docker (`docker compose up`) | Modulen utan Docker (Vite på 3002) |
|---|---|---|
| `ENEO_BACKEND_URL` | `http://host.docker.internal:8123` | `http://localhost:8123` |
| `ENEO_PUBLIC_URL` | `http://localhost:3000` | `http://localhost:3000` |
| `MODULE_PUBLIC_URL` | `http://localhost:3001` | `http://localhost:3002` |
| `COOKIE_SECURE` | `false` | `false` |

Registrera modulen som i [Sätt upp modulen i Eneo](operations.md#sätt-upp-modulen-i-eneo), med callback `<MODULE_PUBLIC_URL>/api/auth/callback`: `http://localhost:3001/api/auth/callback` eller `http://localhost:3002/api/auth/callback`.

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

## Dokumentationen

Sidorna i `docs/` är källan till dokumentationssajten i `docs-site/` (VitePress, ett eget paket som aldrig når imagen). Från `docs-site/`: `npm ci`, sedan `npm run dev` (på `http://localhost:5173`), `npm run build` (misslyckas på en död länk) och `npm run check` (webbläsarkontroll av den byggda sajten; första gången `npx playwright install chromium`). Sidorna är vanlig Markdown med sin rubrik och utan frontmatter, så att de läses likadant på GitHub; bara `docs/index.md` och `docs/api-referens.md` är till för sajten. Sidomenyn står i `docs-site/.vitepress/config.mts`. Mer om sajten, dess gestaltning och beroenden: `docs-site/DESIGN.md`.
