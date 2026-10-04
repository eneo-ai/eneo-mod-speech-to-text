# Tal till text

Syfte: Presentera Tal till text, en Eneo-modul som spelar in samtal och skickar dem till ett publicerat Eneo-flöde, och visa vägen in i dokumentationen.

Läs detta när: Du är ny i repot, vill starta modulen lokalt eller söker rätt sida i `docs/`.

Hör ihop med: [Dokumentationsindex](docs/README.md), [Arkitektur](docs/architecture.md), [Drift](docs/operations.md), [Lokal utveckling](docs/development.md)

Tal till text är en Eneo-modul (repot heter `eneo-mod-speech-to-text`) som låter en inloggad användare spela in ett samtal i webbläsaren (eller ladda upp en ljudfil), skicka det till ett publicerat Eneo-flöde och få tillbaka transkript, sammanfattning och eventuellt genererade filer. Transkriptet kan granskas och talarna namnges. Modulen har ingen egen databas; allt som ska sparas ligger i Eneo.

![Översiktsbild. Till vänster Webbläsare (en person vid en laptop och en telefon) som med en pil och en cookie når Modulen i mitten. Modulen har två kort: Gränssnitt (en mikrofon och en ljudvåg) och Säker backend (en sköld med hänglås och en nyckel). En pil med en nyckel och ett personmärke går från Modulen till Eneo till höger (ett flödesschema och ett dokument), och en tunnare pil med ett dokument går tillbaka. Ovanför Modulen sitter en list: Egen logga, namn och färg.](docs/images/arkitektur-oversikt.png)

Bilden är illustrativ. Mermaid-diagrammen i [Arkitektur](docs/architecture.md) är den beskrivning som gäller.

Eneos nycklar och användartoken stannar i backendprocessen. Webbläsarens HttpOnly-cookie innehåller bara ett slumpmässigt sessions-ID, och frontend pratar bara same-origin. Se [Arkitektur](docs/architecture.md) för diagram.

## Snabbstart

```bash
cp .env.example .env    # fyll i ENEO_*, MODULE_*, ENEO_API_KEY, SESSION_SECRET; COOKIE_SECURE=false lokalt
docker compose up --build
open http://localhost:3000
```

Utan Docker (devcontainer): backend från `backend/` med miljön inläst från `.env`, frontend från `frontend/` med `npm run dev` på http://localhost:3002. Alla steg: [Lokal utveckling](docs/development.md).

```bash
.venv/bin/python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000 --no-access-log --ws-max-size 131072 --ws-max-queue 16
```

Raden ovan läses av `backend/tests/test_live_relay.py` och måste ha samma WebSocket-gränser som produktionsimagen. Ändra den inte utan att ändra testet.

## Egen organisation

En annan kommun eller myndighet byter namn, logga och accentfärg utan att ändra kod eller bygga om imagen: sex miljövariabler på backend-tjänsten (`ORGANIZATION_NAME`, `ORGANIZATION_LOGO`, `ORGANIZATION_LOGO_DARK`, `SHOW_ORGANIZATION`, `ORGANIZATION_ACCENT`, `ORGANIZATION_ACCENT_DARK`). Utan dem visas Sundsvalls kommun och modulens standardblå. Guiden med kraven och felmeddelandena: [Byt organisation](docs/branding.md).

## Status

| Status | Vad |
|---|---|
| Nuvarande | Next.js 16 är frontend-servern och FastAPI ligger internt bakom den: båda i en image under supervisord (port 3001), eller som två containrar i Compose. Inloggning med Eneo SSO; `access_code` är en tillfällig testgrind. |
| Klart | Gränssnittet är byggt på Astryx; shadcn, Radix och Tailwind är borttagna. |
| Planerat | Plan B: en process där FastAPI serverar gränssnittet som statiska filer (en Vite-app) i stället för Next.js. Beslutad och byggs på grenen `feat/one-process`. Därtill ett delat modulkit i ett eget repo. Se [Arkitektur](docs/architecture.md#läget-i-dag). |

## Karta över dokumentationen

Hela indexet med status finns i [docs/README.md](docs/README.md).

| Jag vill … | Läs |
|---|---|
| förstå hur det hänger ihop | [Arkitektur](docs/architecture.md) |
| förstå inloggning och session | [Inloggning och session](docs/auth-and-session.md) |
| ändra backend eller se inställningarna | [Backend](docs/backend.md) |
| se hur modulen pratar med Eneo | [Eneo-integration](docs/eneo-integration.md), [Inspelaren](docs/recording.md), [Granska transkriptet](docs/transcript-review.md) |
| bygga eller ändra en skärm | [Frontend](docs/frontend.md), [Designsystem](docs/design-system.md) |
| köra tester och tillgänglighetsgrinden | [Kvalitetsgrindar](docs/quality-gates.md) |
| driftsätta eller felsöka | [Drift](docs/operations.md) |
| byta organisationens namn, logga och accentfärg | [Byt organisation](docs/branding.md) |
| starta lokalt | [Lokal utveckling](docs/development.md) |
| veta varför något är som det är | [Beslut](docs/decisions/README.md) |
| förstå en term | [Ordlista](docs/glossary.md) |

Arbetar du som AI-agent, börja med [`AGENTS.md`](AGENTS.md) (engelska).

## Licens

GNU Affero General Public License v3.0 (`AGPL-3.0-only`), samma licens som Eneo. Se [LICENSE](LICENSE).
