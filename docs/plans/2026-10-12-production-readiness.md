# Produktionsberedskap: Tal till text, kandidat a0272ad

Datum: 2026-10-12. Beslutsunderlag för ägaren (bead `stt-66h`). Planeringsdokument som tas bort med byggställningen (bead `stt-plan-a-astryx-port-57a.24`); det permanenta innehållet står i `docs/operations.md` och `docs/quality-gates.md`.

## Beslut i korthet

Modulen på `main` vid `a0272ad` är färdig att driftsättas för acceptans. Den är inte godkänd för verklig användning förrän kontrollerna i avsnittet "Innan verklig användning" är gjorda på den riktiga domänen, mot det riktiga Eneo, och utfallet är antecknat.

Rekommenderad kandidat: tagga `v0.1.1` på `a0272ad`. Utgåvan `v0.1.0` (`c5d5460`, 2026-10-08) saknar PR 24, som talar om före inspelningen när talare inte kan märkas upp. `release.yml` kopierar den redan testade imagen `sha-a0272ad…` till `v0.1.1` och `latest` utan att bygga om.

## Kandidaten och vad som är bevisat

| | |
|---|---|
| Commit | `a0272ad69ccbbe6c23fff538e12fd1be43d5ad78`, `main`, 2026-10-11 |
| CI | körning 38159169055, alla jobb gröna: backend, frontend, frontend-browser (controls 4 delar, accessibility 2 delar, production, real-backend, branding), compose, image, publish |
| Image | `ghcr.io/eneo-ai/eneo-mod-speech-to-text:sha-a0272ad69ccbbe6c23fff538e12fd1be43d5ad78`, digest `sha256:b452b6291d5dd5b86ee4e943e405d457eade2b821759def2f90f5c91d1e7f489` (OCI-index, två plattformar) |
| Senaste utgåva | `v0.1.0` = `latest` = `c5d5460`, digest `sha256:8e66e9af8eab984058921725d5c5ffc7cf608aec00b8ce54cb46a38639f48417` |
| Imagens acceptans | `deploy/acceptance.sh` i jobbet image: hälsa, en process och icke-root, headers, uppladdningar, WebSocket, stopp med strömmande fil, storlek och minne, reläets fördröjning under last. Kontroll 15 är villkorat godtagen av ägaren 2026-10-05 (`deploy/acceptance/waivers.json`): reläet är opåverkat upp till en tredjedel av vad modulen klarar; bara mättnad med 200 klienter utan paus tar p95 över dubbla viloläget. |

Acceptansen kör med stubben som Eneo. Den bevisar imagen, inte driftsmiljön.

## Säkerhet

- **Granskning run-1** (`~/security-audit-skill/eneo-mod-speech-to-text/run-1`, bead `stt-p5u.1`): den fristående appen vid `70cf9f9`, 33 gränser och livscykler, 281 godkända tester i isolerad container, inga bekräftade sårbarheter och inga kandidater kvar. Utanför omfattningen: Eneos faktiska behörighet mellan användare och ytor, driftsmiljöns TLS, cookies och headers, fysisk Safari, modulkittet.
- **Deltagranskning `70cf9f9..a0272ad`** (33 filer, gjord 2026-10-12): ingen backendkod ändrad (bara `backend/tests/test_release_workflows.py`). Frontend: flöden vars talarmärkning inte kan göras blockeras utan väg in (`flow-session.ts`, `FlowInput.tsx`, `ReadyPanel.tsx`, `UnsentRecordings.tsx`), två nya felförklaringar (`run-result.ts`), utloggningssidans text om kvarvarande inspelningar läser bara routerns state (`LoginPage.tsx`), kontraktstypen får `unavailable_reason` (`api.ts`). CI: webbläsartesterna delas på flera körare, Skopeo fäst vid en bevarad immutable utgåva och kontrolleras före bygget, docs-flödet får manuell körning och Pages-kontroll. Inga nya nätverksanrop, inga nya förtroendegränser, inget som ändrar auditens slutsats.
- **Återstår** och kan bara göras på den riktiga domänen: se "Innan verklig användning".

## Kända begränsningar (permanent beskrivna i docs)

- En process, en replik: sessionslagret är processlokalt; en omstart loggar ut alla ([Drift](../operations.md#uppgradera), [Backend](../backend.md#kända-begränsningar)).
- Uppladdningar mellanlagras på disk i volymen `spool`; disken ska rymma `MAX_CONCURRENT_UPLOADS` × `MAX_UPLOAD_BYTES` ([Drift](../operations.md#uppladdningens-tillfälliga-lagring)).
- Proxyn måste ha `readTimeout` över 60 s, och en body-gräns som rymmer `MAX_UPLOAD_BYTES` ([Drift](../operations.md#vad-som-står-framför-modulen)).
- Full återgivning kräver Chrome/Edge 125, Safari 26 eller Firefox 147; äldre webbläsare placerar menyer och väljare fel ([Drift](../operations.md#vad-en-användare-behöver)).
- Osänt ljud ligger kvar i användarens webbläsare tills det skickas eller tas bort; ingen tidsgräns (ägarbeslut 2026-10-07, [Inspelning](../recording.md)).
- Kapaciteten är en process; mer kräver ett delat sessionslager ([Drift](../operations.md#kapacitet-för-live-texten)).
- Ingen accesslogg i modulen; proxyns logg får inte skriva callbackens query ([Drift](../operations.md#loggar)).

## Innan verklig användning

Ordningen är: byt en gång på den riktiga domänen (stoppa den gamla, starta kandidaten), gör acceptansen med testkonton och påhittat material innan modulen annonseras, anteckna utfallet på bead `stt-plan-b-one-process-runtime-bbs.24`, släpp sedan in verklig användning på samma container. Checklistan står permanent i [Drift](../operations.md#acceptans-innan-verklig-användning).

| Kontroll | Vem | Hur |
|---|---|---|
| Inloggning via Eneo och tillbaka till flödeslistan med ren adress | ägaren | privat fönster |
| Eneos behörighet: två testkonton i två ytor når sina egna flöden, körningar, filer, resultat, granskningar och livesessioner (positiv kontroll) och inte varandras, genom modulens adresser | ägaren med Eneo-admin | två testkonton med egna flöden och körningar |
| TLS, HSTS, `Secure`-cookie, modulens headers | agent eller ägare | `curl -sI` mot domänen, cookie-flaggor i webbläsaren |
| Traefik: `readTimeout` ≥ 1800 s på ingångspunkten, body-gräns ≥ `MAX_UPLOAD_BYTES`; en fil strax under taket från webbläsaren vid den långsammaste lovade hastigheten, med avbrott och återupptagning, går igenom; en fil över taket avvisas med 413 | ägaren i Dokploy | konfigurationen och riktiga uppladdningar ([Drift](../operations.md#acceptans-innan-verklig-användning)) |
| Volymen `spool` ligger på disk med rätt storlek och behörigheter; ingen annan tjänst läser den | ägaren | värden |
| Proxyns logg skriver inte `/api/auth/callback?…` | ägaren | loggen efter en inloggning |
| Fysisk Safari 17 eller 18: konto-menyn, väljaren, dialogerna, mikrofonen, återupptagen inspelning, osänd inspelning kvar efter utloggning och ny inloggning | ägaren (bead `stt-plan-a-astryx-port-57a.8`) | iPhone eller iPad mot domänen |
| En livesession, en inspelning, en uppladdning och ett resultat med PDF | ägaren | ett helt varv |
| En vecka utan incident | ägaren | därefter stängs `bbs.24`, `bbs.3` och Plan B-epiken |

## Driftsättningspaket (bead bbs.24)

**Topologi.** Den gamla driftsättningen är två containrar byggda från källkod (`frontend` på 3000 med `INTERNAL_API_BASE`, `speech-to-text-backend` på 8000). Den nya är en tjänst, `speech-to-text`, port 3001, från den publicerade imagen; `docker-compose.yml` i utgåvan. Domänen i Dokploy pekas om till tjänsten `speech-to-text`, port 3001.

**Miljövariabler.** Oförändrade: `ENEO_BACKEND_URL`, `ENEO_PUBLIC_URL`, `MODULE_PUBLIC_URL`, `MODULE_KEY`, `ENEO_API_KEY`, `ENEO_API_KEY_HEADER_NAME`, `SESSION_SECRET`, `COOKIE_SECURE`, `SESSION_MAX_AGE_MINUTES`, `UPLOAD_PROXY_TIMEOUT_SECONDS`, `ORGANIZATION_*`, `SHOW_ORGANIZATION`. Borttagna, ska inte sättas: `AUTH_MODE`, `APP_ACCESS_CODE`, `DEMO_SPACE_ID`, `INTERNAL_API_BASE`, `NEXT_PUBLIC_*`. Nya, med standardvärden: `MODULE_VERSION` (imagens tagg), `UPLOAD_RECEIVE_*`, `UPLOAD_RESUME_IDLE_TIMEOUT_SECONDS`, `MAX_CONCURRENT_UPLOADS`, `MAX_CONCURRENT_HEAVY_IO`, `MAX_BODY_BYTES`, `MAX_UPLOAD_BYTES`, `MAX_RESPONSE_BYTES`. Callback-URL:en är densamma, `<MODULE_PUBLIC_URL>/api/auth/callback`, och behöver inte registreras om i Eneo.

**Proxyn.** Traefiks `readTimeout` på ingångspunkten ≥ 1800 s ([så gör du](../operations.md#höj-readtimeout-i-traefik)), HSTS ([så gör du](../operations.md#hsts-i-traefik)).

**Bytet.** En gång: stoppa det gamla projektet, starta det nya, gör acceptansen, släpp sedan in verklig användning på samma container. Två versioner samtidigt skickar personer fel (sessioner i processens minne), och en omstart till loggar ut alla igen utan att bevisa något.

**Användarnas enheter.** Osända inspelningar i webbläsaren överlever bytet: IndexedDB-basen `tal-till-text` version 1 med samma objektlager i den gamla versionen (`f81a7dd`) och i `a0272ad`, och postens form är kompatibel (verifierat med `git diff f81a7dd..a0272ad -- frontend/lib/recording-store.ts`).

**Inspelningar från läget access_code.** Kontrollera vilket `AUTH_MODE` den gamla driftsättningen kör. En inspelning gjord i läget `access_code` har ägaren `access-code` (`f81a7dd:frontend/lib/user-identity.ts`), och den nya versionen visar bara inspelningar vars ägare är Eneo-användarens id (`frontend/lib/recording-store.ts`). Finns osända inspelningar från det läget sparas de som fil i den gamla appen före bytet; schemat räcker inte för att de ska hittas.

**Återgång.** Spara det gamla Dokploy-projektets compose-fil, miljövariabler och domänens koppling (tjänst och port) innan bytet; den gamla imagen byggdes av Dokploy från källkoden, så en återgång är att driftsätta det sparade projektet igen från samma commit. Den nya imagen rör inget utanför sin egen container och volymen `spool`.

## Ägarbeslut som väntar

- Kandidat: tagga `v0.1.1` på `a0272ad` (rekommenderas) eller driftsätt `v0.1.0`.
- Bead `stt-plan-a-astryx-port-57a.7`: sju designval som levererats med standardvärdet på `main`; bekräfta eller ändra.
- Bead `stt-plan-a-astryx-port-57a.35`: bekräfta att designartefakten (claude.ai-länken) är det som efterfrågades, och stäng.
- Bead `stt-plan-a-astryx-port-57a.8`: Safari-kontrollen ovan.

## Efter driftsättningen

- `stt-9xi` Visa driftsatt version: källidentitet bakas in vid CI-bygget (OCI-etiketter och en byggpost ur samma indata, som backend läser), `/health` visar commit och byggdatum, uttryckligen som byggdatum. Utgåvan är ett eget, tomt-tillåtet fält: `MODULE_VERSION` skickas in i containern som driftsättningsmetadata, men `latest`, en `sha-`-tagg och ett lokalt bygge (`docker-compose.override.yml`) betyder ingen känd utgåva, och vid driftsättningen kontrolleras kedjan utgåvans tagg → digest → inbakad commit. Gränssnittet visar utgåvan när den är känd, annars bara commit. Utgåvans tagg kan inte bakas in: `release.yml` taggar om en redan testad digest.
- `stt-plan-a-astryx-port-57a.24` Städning: migrationsavsnittet i `AGENTS.md`, `docs/plans/` och till sist `.beads/` efter export. `frontend/lib/legacy-ui.test.ts` är ett levande vakttest mot Next, Radix, Tailwind och klasssträngar och tas inte bort.
- `stt-plan-c-module-kit-gwh.3` Kitet: uppskjutet. Återöppnas när kitet är släppt i 0.1.0 med både BFF- och UI-paket och antingen en andra modul börjar eller en gemensam inloggningsrättelse måste landa i båda. Tills dess är `backend/app/serve.py` en kopia från kitet och modulen referensimplementationen.
- `stt-p5u` Slutlig säkerhetsgranskning: den fristående delen är gjord (run-1 plus deltagranskningen ovan); kvar är kontrollerna på den riktiga domänen, och kit-delen bara om kitet införs.
