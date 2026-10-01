# Ordlista

Syfte: Fastställa vad varje term betyder i den här dokumentationen, så att samma ord alltid betyder samma sak.

Läs detta när: Du stöter på en term du inte kan placera, eller vill veta vilket ord som ska användas i text och kod.

Hör ihop med: [Arkitektur](architecture.md), [Inloggning och session](auth-and-session.md), [Eneo-integration](eneo-integration.md)

## Kärntermer

| Term | Betydelse | Engelska i kod och samtal |
|---|---|---|
| modul | En fristående webbapplikation som Eneo kan installera och länka till. Den här modulen heter Tal till text (kodnamn Lyssna), `MODULE_KEY=speech-to-text`. | module |
| Eneo | Plattformen modulen pratar med: användare, flöden, körningar, filer och inloggning. Modulen är aldrig Eneos egen frontend. | Eneo |
| BFF | Modulens egen backend i FastAPI (`backend/app/`). Den står mellan webbläsaren och Eneo: håller inloggningen, lägger på credentials och släpper bara igenom tillåtna anrop. Står för "backend for frontend". | BFF |
| modulsession | Modulens egen inloggning i webbläsaren: en HttpOnly-cookie med ett slumpmässigt, opakt ID. Allt som hör till sessionen (Eneos token) ligger i BFF:ens minne. | module session |
| servicenyckel | Modulens `sk_`-nyckel i Eneo (`ENEO_API_KEY`). Den skickas från BFF:en på varje anrop till Eneo och når aldrig webbläsaren. | service key |
| modultoken | Kortlivad token som Eneo ger BFF:en för den inloggade användaren (module-user token). Skickas tillsammans med servicenyckeln i `eneo_sso`-läget. | module-user token |
| ticket | Engångsbiljett som Eneo skickar tillbaka efter inloggning. BFF:en växlar den mot en modultoken. | ticket |
| flöde | Ett publicerat arbetsflöde i Eneo som tar emot ljud eller filer och ger ett resultat (transkript, sammanfattning, filer). Användaren väljer ett flöde i modulen. | flow |
| körning | En enskild exekvering av ett flöde med en användares indata. Har status och kan pausa för granskning. | run |
| steg | En del av ett flöde. Ljudsteget tar emot inspelningen. | step |
| granskning | En paus i en körning där en människa kontrollerar eller rättar ett stegs resultat (`awaiting_review`). Talarmappning är en sådan granskning. | review, checkpoint |
| talarmappning | Granskningen "Vem är vem?" där talaretiketter (`SPEAKER_00` …) får namn. | speaker mapping |
| tjänst | En container i Docker Compose, till exempel `frontend` och `speech-to-text-backend`. Används aldrig om en Eneo-funktion. | service |
| space | Eneos avgränsade arbetsyta. En användare kan vara medlem i flera. Flödeslistan visar flöden över användarens spaces. | space |

## Lägen och funktioner

| Term | Betydelse |
|---|---|
| `eneo_sso` | Standardläget för inloggning. Eneo autentiserar användaren, modulen är ingen egen OIDC-klient. |
| `access_code` | Tillfällig testgrind med en delad åtkomstkod, tills Eneos modulhandoff är deployad. Ger ingen användaridentitet. |
| Strömma | Inmatningsläget som visar text medan man spelar in (live-text). |
| Spela in | Inmatningsläget som spelar in nu och transkriberar efteråt. |
| Ladda upp | Inmatningsläget där man väljer en ljudfil. |
| Tidigare körningar | Listan över användarens körningar av ett flöde på flödets sida. |

## Gränssnitt och kvalitet

| Term | Betydelse |
|---|---|
| Astryx | Designsystemet (`@astryxdesign/core`) som modulens gränssnitt byggs av. Version fastlåst i `frontend/package.json`. |
| tema | Eneo-temat i `frontend/kit/theme/eneo.theme.ts`: accentfärg, typsnitt, pekstorlekar och fokusring. Byggs till statiska filer. |
| kit | Mappen `frontend/kit/` (tema, providers, skal). Ska på sikt bli ett delat modulkit. |
| ytor med CSS-modul | De få specialytor som får ha en CSS-modul med Astryx-tokens i stället för komponenter. |
| grinden | Tillgänglighetsgrinden: Playwright-testerna i `frontend/tests/e2e/` som körs med `npm run test:a11y`. |
| viktbudget | Gränsen för hur mycket komprimerad JS och CSS en sida får ladda: `frontend/tests/prod/weight-budget.json`. |
| modulskal | `ModuleShell` (`frontend/kit/ModuleShell.tsx`): sidans ram med toppfält, hoppa-till-innehåll-länk och huvudregion. |
| täckskiktet | Det som döljer och låser sidan medan inloggningen har gått ut, medan inspelningen fortsätter (`SignedOutCover` i `frontend/components/AuthGate.tsx`). |

## Drift

| Term | Betydelse |
|---|---|
| produktionsimagen | Den publicerade containern `ghcr.io/eneo-ai/eneo-mod-speech-to-text`: båda processerna under supervisord, port 3001. |
| tvåcontainerfilen | `docker-compose.yml`: frontend och backend som två tjänster, för lokal utveckling och fristående Dokploy. |
| `module_net` | Eneos interna nätverk där modulens container nås av Eneos övriga tjänster i en Eneo-installation. |
| Dokploy | Plattformen som hostar den fristående testmiljön (`transkribering.sundsvall.dev`). |
