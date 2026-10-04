# Dokumentationsindex

Syfte: Visa alla sidor i dokumentationen, vad var och en är till för, vem den är till för och om den är aktuell.

Läs detta när: Du söker rätt dokument, ska lägga till ett nytt, eller vill veta vad som är aktuellt, under arbete, historiskt eller tillfälligt.

Hör ihop med: [README](../README.md), [Arkitektur](architecture.md), [Ordlista](glossary.md), [Beslut](decisions/README.md)

## Börja här

| Du är | Läs i den här ordningen |
|---|---|
| Ny utvecklare | [README](../README.md), [Arkitektur](architecture.md), [Lokal utveckling](development.md), [Frontend](frontend.md), [Backend](backend.md) |
| Operatör | [Drift](operations.md), [Byt organisation](branding.md), [Inloggning och session](auth-and-session.md), [Backend (inställningar)](backend.md#inställningar) |
| Granskar säkerhet | [Inloggning och session](auth-and-session.md), [Backend (säkerhetsegenskaper)](backend.md#säkerhetsegenskaper), [Beslut 0005](decisions/0005-deny-by-default-proxy-and-body-limits.md) |
| Bygger en skärm | [Frontend](frontend.md), [Designsystem](design-system.md), [Kvalitetsgrindar](quality-gates.md) |
| Ett AI-verktyg | [`AGENTS.md`](../AGENTS.md) (engelska), därefter sidorna ovan efter uppgift |

## Sidor

Status: **Aktuell** stämmer med koden. **Under arbete** beskriver något som ändras just nu. **Historisk** beskriver ett läge som varit. **Tillfällig** tas bort när portningen är klar.

| Sida | Syfte | Målgrupp | Status |
|---|---|---|---|
| [README](../README.md) | Översikt, snabbstart och karta | alla | Aktuell |
| [Arkitektur](architecture.md) | Delar, diagram över inloggning, proxy, filer, drift, lager och märke | utvecklare, operatör | Aktuell (Astryx-portningen pågår) |
| [Inloggning och session](auth-and-session.md) | Handoff, sessionslager, förnyelse, vad som aldrig når webbläsaren | utvecklare, säkerhet | Aktuell |
| [Backend](backend.md) | Rutter, tillåtelselista, uppladdningar, filer, inställningar, säkerhetsegenskaper | utvecklare | Aktuell |
| [Eneo-integration](eneo-integration.md) | Körningskontraktet, granskning, talarmappning, live-text | utvecklare | Aktuell |
| [Inspelaren](recording.md) | Format, lagring på enheten, fortsätta, delar, flikar, nya försök | utvecklare | Aktuell |
| [Granska transkriptet](transcript-review.md) | Hur granskningen används och slås på | användare, utvecklare | Aktuell |
| [Frontend](frontend.md) | Lager, konventioner, tillstånd, sidornas lägen, ny skärm | utvecklare | Aktuell, en del är tillfällig (Migration) |
| [Designsystem](design-system.md) | Astryx, Eneo-temat, rätta en brist en gång, tillgänglighetsnivå | utvecklare | Aktuell, en del är tillfällig (Migration) |
| [Kvalitetsgrindar](quality-gates.md) | Alla kontroller, hur de körs, hur ett fel läses | utvecklare | Aktuell, en del är tillfällig (Migration) |
| [Drift](operations.md) | Miljövariabler, Compose, imagen, Dokploy, headers, felsökning | operatör | Aktuell |
| [Byt organisation](branding.md) | Namn, logga och accentfärg: variabler, krav, kontrastregler, felmeddelanden, kontroll | operatör | Aktuell |
| [Lokal utveckling](development.md) | Starta lokalt, devcontainer, stub, portar | utvecklare | Aktuell |
| [Ordlista](glossary.md) | Vad termerna betyder | alla | Aktuell |
| [Beslut](decisions/README.md) | Arkitekturbeslut, ett per fil | utvecklare | Aktuell |

## Äldre dokument

Dessa är inte omskrivna; de finns kvar som historik. Vid skillnad gäller koden och sidorna ovan.

| Dokument | Vad det är | Status |
|---|---|---|
| [handover-eneo-transcript-editor-2026-09-15.md](handover-eneo-transcript-editor-2026-09-15.md) | Överlämning till Eneo-teamet av talargranskningen och redigeringen, 2026-09-15 (engelska). | Historisk. Kontraktet som gäller nu: [Eneo-integration](eneo-integration.md). |
| [speaker-review-rollout.md](speaker-review-rollout.md) | Leveransstatus för talargranskningen (engelska). | Historisk leveransstatus; kontrollera mot koden. Användning: [Granska transkriptet](transcript-review.md). |
| [accessibility-review-2026-09-15.md](accessibility-review-2026-09-15.md) och [accessibility-audit-results-2026-09-15.json](accessibility-audit-results-2026-09-15.json) | Tillgänglighetsgranskning av transkriptredigeraren och dess mätresultat (engelska). JSON-filen läses av `frontend/tests/accessibility-audit.cjs`. | Historisk baslinje. Dagens bevis är grinden: [Kvalitetsgrindar](quality-gates.md). |
| [../design/DESIGN.md](../design/DESIGN.md) och [../design/prototyp.html](../design/prototyp.html) | Designregler och en fristående prototyp för claude.ai, skrivna för shadcn/Tailwind-stacken. Prototypen laddar Tailwind från en CDN och skeppas aldrig (`.dockerignore` utesluter `design`). | Föråldrad under portningen. Se [Designsystem](design-system.md). |

## Agentinstruktioner

| Fil | Vad |
|---|---|
| [../AGENTS.md](../AGENTS.md) | Regler för AI-agenter (engelska): UI-regler, produktregler, kontroller, katalogkarta, vad man inte rör. |
| [../CLAUDE.md](../CLAUDE.md) | Pekare till `AGENTS.md`. |
| [../frontend/AGENTS.md](../frontend/AGENTS.md) | Block som Astryx-CLI:t genererar. Rörs inte för hand. |

## Migration (temporary, removed by bead .24)

`docs/plans/` hör till portningen och tas bort när den är klar. Inga permanenta sidor ovan får bero på den.

| Sida | Vad |
|---|---|
| [plans/2026-10-01-astryx-port-plan.md](plans/2026-10-01-astryx-port-plan.md) | Genomförandeplanen för portningen (Plan A). |
| [plans/2026-10-01-module-platform-design.md](plans/2026-10-01-module-platform-design.md) | Beslutsunderlaget för Astryx, en process och modulkitet. |

## Skriva dokumentation

- **Språk:** allt en människa läser här är svenska. `AGENTS.md`, `CLAUDE.md` och kodkommentarer är engelska. Håll termerna enhetliga enligt [Ordlistan](glossary.md).
- **Sidhuvud:** varje sida börjar med tre rader: `Syfte:` (en mening), `Läs detta när:` (situationerna) och `Hör ihop med:` (länkar).
- **Korta avsnitt, tabeller för fakta.** Ett faktum på ett ställe; länka i stället för att upprepa. Relativa länkar. Ingen marknadsföringsprosa.
- **Varje påstående om koden har en sökväg** (`backend/app/x.py`), aldrig ett radnummer. Beskriv kataloger och konventioner, inte varje fil: filer flyttas.
- **Kommandon går att klistra in** och säger från vilken katalog de körs.
- **Diagram** är Mermaid i fenced-block (bara `flowchart` och `sequenceDiagram`, kort etikett, citerade etiketter med skiljetecken, inget HTML i etiketter) med en mening ovanför som säger vad man ska titta på. Orden `end`, `graph`, `subgraph`, `class` och `style` är reserverade och får inte vara nod-id. Mermaid-diagrammen är källan; bilden i [Arkitektur](architecture.md) är en översikt.
- **Koden vinner.** Skiljer sig en sida från koden, rätta sidan.
- **Märk vad som är aktuellt, under arbete och planerat.** Material som bara hör till portningen står under rubriken `## Migration (temporary, removed by bead .24)`, så att det kan tas bort i ett svep.
- **Testet som läser README.** `backend/tests/test_live_relay.py` läser raden som börjar med `.venv/bin/python -m uvicorn` ur `README.md`. Flytta eller ändra den inte utan att ändra testet.
