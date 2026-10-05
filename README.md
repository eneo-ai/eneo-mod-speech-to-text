# Tal till text

Tal till text är en Eneo-modul (repot heter `eneo-mod-speech-to-text`): du spelar in ett samtal i webbläsaren eller laddar upp en ljudfil, och ett publicerat Eneo-flöde gör text av det.

## Kom igång

```bash
git clone https://github.com/eneo-ai/eneo-mod-speech-to-text && cd eneo-mod-speech-to-text
cp .env.example .env   # fyll i ENEO_BACKEND_URL, ENEO_PUBLIC_URL, ENEO_API_KEY, SESSION_SECRET
                       # lokalt också MODULE_PUBLIC_URL=http://localhost:3001 och COOKIE_SECURE=false
docker compose up --build
open http://localhost:3001
```

**Obs:** bakom Traefik v3.7 är `readTimeout` 60 s som standard, och det kapar uppladdningar som tar längre tid. Höj den på ingångspunkten: [Drift](docs/operations.md#vad-som-står-framför-modulen).

Mer: [Lokal utveckling](docs/development.md) (utan Docker, utan Eneo), [Drift](docs/operations.md), [Arkitektur](docs/architecture.md) och [API-referens](docs/backend.md). Alla sidor finns också som webbplats: https://eneo-ai.github.io/eneo-mod-speech-to-text/. Arbetar du som AI-agent, börja med [`AGENTS.md`](AGENTS.md) (engelska).

## Licens

GNU Affero General Public License v3.0 (`AGPL-3.0-only`), samma licens som Eneo. Se [LICENSE](LICENSE).
