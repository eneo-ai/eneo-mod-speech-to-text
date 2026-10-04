# Tal till text

Tal till text är en Eneo-modul (repot heter `eneo-mod-speech-to-text`): en inloggad användare spelar in ett samtal i webbläsaren eller laddar upp en ljudfil, skickar det till ett publicerat Eneo-flöde och får tillbaka transkript, sammanfattning och eventuella filer. Transkriptet kan granskas och talarna namnges. Modulen har ingen egen databas; allt som ska sparas ligger i Eneo.

![Översikt: webbläsare, modulen med gränssnitt och säker backend, och Eneo](docs/images/arkitektur-oversikt.png)

Modulen är en container med en process, `python -m app.serve` på port 3001, som serverar det byggda gränssnittet och API:t. Eneos nycklar och användartoken stannar i backendprocessen; webbläsarens HttpOnly-cookie innehåller bara ett slumpmässigt sessions-ID och webbläsaren pratar bara same-origin. Diagram: [Arkitektur](docs/architecture.md).

## Köra den

Imagen `ghcr.io/eneo-ai/eneo-mod-speech-to-text:<version>` körs med `docker-compose.yml` i Dokploy eller Portainer. Variabler, proxy, uppdatering och felsökning: [Drift](docs/operations.md#driftsätt-med-dokploy-eller-portainer).

Lokalt bygge:

```bash
cp .env.example .env    # fyll i ENEO_BACKEND_URL, ENEO_PUBLIC_URL, ENEO_API_KEY och SESSION_SECRET
                        # lokalt också MODULE_PUBLIC_URL=http://localhost:3001 och COOKIE_SECURE=false
docker compose up --build
open http://localhost:3001
```

Utveckling utan Docker och alla tester: [Lokal utveckling](docs/development.md), [Tester](docs/quality-gates.md).

## Egen organisation

En annan kommun eller myndighet byter namn, logga och accentfärg utan att ändra kod eller bygga om imagen, med sex miljövariabler på tjänsten. Utan dem visas Sundsvalls kommun och modulens standardblå. [Byt organisation](docs/branding.md).

## Dokumentation

Alla sidor: [docs/README.md](docs/README.md). Arbetar du som AI-agent, börja med [`AGENTS.md`](AGENTS.md) (engelska).

## Licens

GNU Affero General Public License v3.0 (`AGPL-3.0-only`), samma licens som Eneo. Se [LICENSE](LICENSE).
