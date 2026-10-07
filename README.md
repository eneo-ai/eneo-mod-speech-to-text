# Tal till text

Tal till text är en Eneo-modul (repot heter `eneo-mod-speech-to-text`): du spelar in ett samtal i webbläsaren eller laddar upp en ljudfil, och ett publicerat Eneo-flöde gör text av det.

## Kom igång

1. **Du behöver ett Eneo som modulen når**, med en servicenyckel och modulen installerad ([Sätt upp modulen i Eneo](docs/operations.md#sätt-upp-modulen-i-eneo)). Har du inget kör du stubben som Eneo i stället ([utan Eneo](docs/development.md#den-riktiga-backenden-utan-ett-eneo)).
2. **Hämta koden och inställningarna:**

   ```bash
   git clone https://github.com/eneo-ai/eneo-mod-speech-to-text && cd eneo-mod-speech-to-text
   cp .env.example .env
   ```

3. **Fyll i `.env`:** `ENEO_BACKEND_URL`, `ENEO_PUBLIC_URL`, `ENEO_API_KEY` och `SESSION_SECRET` (skapa den med `python -c "import secrets; print(secrets.token_urlsafe(48))"`). För lokal körning också `MODULE_PUBLIC_URL=http://localhost:3001` och `COOKIE_SECURE=false`. Kör Eneo på din egen dator, på port 8123 för API:t och 3000 för webben, är `ENEO_BACKEND_URL=http://host.docker.internal:8123` (så når containern din dator) och `ENEO_PUBLIC_URL=http://localhost:3000` (så når webbläsaren den).
4. **Starta:** `docker compose up --build`
5. **Öppna** `http://localhost:3001` i webbläsaren.

> [!WARNING]
> **Traefik kapar uppladdningar efter 60 s.** Kör du modulen bakom Traefik v3.7 är `readTimeout` 60 s som standard. Höj den på ingångspunkten: [så gör du](docs/operations.md#höj-readtimeout-i-traefik).

Mer: [Lokal utveckling](docs/development.md) (utan Docker, utan Eneo), [Drift](docs/operations.md), [Arkitektur](docs/architecture.md) och [API-referens](docs/backend.md). Alla sidor finns också som webbplats: https://eneo-ai.github.io/eneo-mod-speech-to-text/. Arbetar du som AI-agent, börja med [`AGENTS.md`](AGENTS.md) (engelska).

## Licens

GNU Affero General Public License v3.0 (`AGPL-3.0-only`), samma licens som Eneo. Se [LICENSE](LICENSE).
