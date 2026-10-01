# Eneo Speech-to-Text Module

Syfte: Presentera Tal till text (kodnamn Lyssna), en Eneo-modul som spelar in samtal och skickar dem till ett publicerat Eneo-flöde, och visa vägen in i dokumentationen.

Läs detta när: Du är ny i repot, vill starta modulen lokalt eller söker rätt sida i `docs/`.

Hör ihop med: [Dokumentationsindex](docs/README.md), [Arkitektur](docs/architecture.md), [Drift](docs/operations.md), [Lokal utveckling](docs/development.md)

Lyssna är en Eneo-modul som låter en inloggad användare spela in ett samtal i webbläsaren (eller ladda upp en ljudfil), skicka det till ett publicerat Eneo-flöde och få tillbaka transkript, sammanfattning och eventuellt genererade filer. Transkriptet kan granskas och talarna namnges. Modulen har ingen egen databas; allt som ska sparas ligger i Eneo.

![Översikt: webbläsare, Next.js, FastAPI-BFF och Eneo](docs/images/arkitektur-oversikt.png)

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

## Status

| Status | Vad |
|---|---|
| Nuvarande | Next.js och FastAPI i en image under supervisord (port 3001), eller två containrar i Compose. Inloggning med Eneo SSO; `access_code` är en tillfällig testgrind. |
| Under arbete | Gränssnittet porteras från shadcn/Radix/Tailwind till Astryx. Se [Arkitektur](docs/architecture.md#migration-temporary-removed-by-bead-24). |
| Planerat | En process där FastAPI serverar gränssnittet som statiska filer, och ett delat modulkit i ett eget repo. Se [Arkitektur](docs/architecture.md#läget-i-dag). |

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
| driftsätta, felsöka eller byta organisationens märke | [Drift](docs/operations.md) |
| starta lokalt | [Lokal utveckling](docs/development.md) |
| veta varför något är som det är | [Beslut](docs/decisions/README.md) |
| förstå en term | [Ordlista](docs/glossary.md) |

Arbetar du som AI-agent, börja med [`AGENTS.md`](AGENTS.md) (engelska).
