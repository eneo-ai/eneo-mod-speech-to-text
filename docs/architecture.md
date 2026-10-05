# Arkitektur

![Översikt: webbläsare, modulen med gränssnitt och säker backend, och Eneo](images/arkitektur-oversikt.png)

Bilden är en översikt; diagrammen nedan är beskrivningen som gäller.

Modulen är en process, `python -m app.serve`, i en container. Den serverar det byggda gränssnittet (statiska filer) och API:t (en FastAPI-backend, BFF:en) på port 3001. Webbläsaren pratar bara med modulen; modulen pratar med Eneo.

| Del | Vad den gör | Var den finns |
|---|---|---|
| Webbläsaren | Spelar in ljud, visar gränssnittet, talar bara same-origin med modulen. Har aldrig Eneos credentials. | `frontend/` byggs till `dist/` |
| BFF (FastAPI) | Serverar gränssnittet, håller modulsessionen, loggar in mot Eneo, lägger servicenyckel och modultoken på varje anrop, släpper bara igenom tillåtna Eneo-rutter, strömmar filer, relayar live-text. | `backend/app/` |
| Eneo | Autentiserar användaren och äger flöden, körningar och filer. | utanför det här repot |

## Begrepp

| Term | Betydelse |
|---|---|
| modul | Den här webbapplikationen, Tal till text (`MODULE_KEY=speech-to-text`), som Eneo länkar till. |
| BFF | Modulens backend i FastAPI (`backend/app/`): håller inloggningen, lägger credentials på och släpper bara igenom tillåtna anrop till Eneo. |
| modulsession | Modulens inloggning i webbläsaren: en HttpOnly-cookie med ett opakt ID. Allt som hör till sessionen ligger i BFF:ens minne. |
| servicenyckel | Modulens `sk_`-nyckel i Eneo (`ENEO_API_KEY`). Når aldrig webbläsaren. |
| modultoken | Kortlivad token Eneo ger BFF:en för den inloggade användaren. Skickas med servicenyckeln. |
| flöde, körning | Ett publicerat arbetsflöde i Eneo, och en enskild exekvering av det med en användares indata. |
| granskning | En paus i en körning där en människa kontrollerar ett stegs resultat (`awaiting_review`). Talarmappning är en granskning. |
| Strömma, Spela in, Ladda upp | Flödessidans tre inmatningslägen: live-text medan man spelar in, inspelning med transkribering efteråt, och en vald fil. |

## Systemkontext

Webbläsaren pratar bara med modulen, modulen pratar med Eneo, och webbläsaren skickas till Eneo bara för att logga in.

```mermaid
flowchart LR
    user["Användare i webbläsaren"]
    proxy["Omvänd proxy: HTTPS"]
    subgraph module["Modulen: en container, en process, port 3001"]
        ui["Statiska filer: det byggda gränssnittet"]
        api["FastAPI: BFF"]
    end
    eneo["Eneo: inloggning, flöden, körningar, filer"]
    user -->|"HTTPS, same-origin"| proxy
    proxy -->|"HTTP"| ui
    proxy -->|"HTTP och WebSocket"| api
    api -->|"servicenyckel och modultoken"| eneo
    user -.->|"omdirigeras vid inloggning"| eneo
```

## Inloggningen

Ticketen går via webbläsaren men växlas mot en token bara av BFF:en, och sessionscookien är ett slumpmässigt ID.

```mermaid
sequenceDiagram
    participant B as Webbläsare
    participant M as Modulens BFF
    participant E as Eneo
    B->>M: GET /api/auth/login
    M-->>B: 303 till Eneo /module-login, state-cookie
    B->>E: /module-login med module_key, redirect_uri och state
    E-->>B: användaren loggar in, 303 tillbaka med ticket och state
    B->>M: GET /api/auth/callback med ticket och state
    M->>M: jämför state med state-cookien
    M->>E: POST /api/v1/module-auth/token/ med servicenyckel och ticket
    E-->>M: modultoken, användare och Eneos sessionstak
    M->>E: GET /api/v1/module-auth/MODULE_KEY/session/ med servicenyckel och token
    E-->>M: samma modul, tenant och användare
    M-->>B: 303 till modulens sida och HttpOnly-sessionscookie
```

Stegen i ord, felkoder och förnyelse: [Inloggning och session](auth-and-session.md).

## Ett proxat anrop

Ett anrop till Eneo når bara fram om det klarar taket, session, origin, sidans användare och tillåtelselistan, och bara några få av webbläsarens headers och modulens egna credentials går vidare.

```mermaid
flowchart TD
    req["Anrop till /api/eneo/..."] --> cap{"Bodyn över MAX_BODY_BYTES?"}
    cap -->|"ja"| r413["413 max_body_bytes"]
    cap -->|"nej"| sess{"Giltig modulsession?"}
    sess -->|"nej"| r401["401 Not authenticated"]
    sess -->|"ja"| org{"POST eller PATCH: Origin är MODULE_PUBLIC_URL?"}
    org -->|"nej"| r403a["403 Invalid request origin"]
    org -->|"ja"| user{"Sidan är för sessionens användare?"}
    user -->|"nej"| r409["409 user_changed"]
    user -->|"ja"| route{"Tillåten metod och sökväg, som den stavas, utan punktsegment, ?, # eller kontrolltecken?"}
    route -->|"nej"| r403b["403 Eneo resource is not exposed"]
    route -->|"ja"| hdr["Bara tillåtna headers går vidare, modulens credentials läggs på, varje sökvägssegment kodas"]
    hdr --> up["httpx mot Eneo /api/v1/..., svaret räknas medan det kommer"]
    up -->|"nätverksfel"| r502a["502 upstream_unreachable"]
    up -->|"längre än MAX_RESPONSE_BYTES, eller kodat"| r502b["502 upstream_too_large"]
    up -->|"omdirigering"| r502c["502 upstream_redirect"]
    up -->|"svar"| resp["Svaret tillbaka utan Set-Cookie, Location och Eneos säkerhets- och cacheheaders"]
```

Allowlisten, headrarna och gränserna: [Backend](backend.md).

## Uppladdning och signerade filer

Uppladdningen läses först efter att BFF:en kontrollerat vem som skickar, och byggs om av BFF:en innan den når Eneo.

```mermaid
flowchart LR
    b["Webbläsare"] -->|"POST multipart, same-origin"| mw{"Content-Length över MAX_UPLOAD_BYTES?"}
    mw -->|"ja"| e413["413 max_upload_bytes"]
    mw -->|"nej"| chk{"Modulsession, Origin och sidans användare ok?"}
    chk -->|"nej"| e4["401, 403 eller 409"]
    chk -->|"ja"| rd["Läser filen till disk: 411 utan Content-Length, 400 om bodyn inte är exakt en fil upload_file"]
    rd --> p["httpx bygger om multipart ur filen"]
    p -->|"servicenyckel och modultoken, inom UPLOAD_PROXY_TIMEOUT_SECONDS i sin helhet"| eneo["Eneo: runtime-files"]
    p -->|"tidsgränsen går ut"| t["504 upstream_upload_timeout"]
    p -->|"nätverksfel"| u["502 upstream_unreachable"]
```

Filer ut ur Eneo: webbläsaren får aldrig Eneos signerade URL. BFF:en hämtar den och strömmar bytes med Range intakt, och bara typer som inte kan köra skript öppnas inline.

```mermaid
sequenceDiagram
    participant B as Webbläsare
    participant M as Modulens BFF
    participant E as Eneo
    B->>M: GET /api/eneo/flows/FLOW/runs/RUN/input-files/FILE/audio med Range
    M->>M: kräv modulsession, avvisa . och .. i id
    alt ingen giltig cachad URL
        M->>E: POST signed-url med servicenyckel och modultoken
        E-->>M: signerad URL
        M->>M: kontrollera svaret, skriv om scheme och värd till ENEO_BACKEND_URL och cacha per session
    end
    M->>E: GET signerad URL med Range, If-Range och Accept
    E-->>M: 200 eller 206, ström
    M-->>B: ström med nosniff, Cache-Control private och no-store, bilaga om typen kan köra skript
```

## Driftsättning

En publicerad image körs som en container. Bara port 3001 tas emot trafik på, och en omvänd proxy framför står för HTTPS.

```mermaid
flowchart LR
    reg["ghcr.io/eneo-ai/eneo-mod-speech-to-text"] -->|"MODULE_VERSION"| c
    subgraph c["Container: skrivskyddad, ingen capability"]
        serve["python -m app.serve, port 3001"]
        spool["/tmp: volym för uppladdningar"]
        serve --- spool
    end
    proxy["Dokploy och Traefik, Portainer eller Eneos module_net"] -->|"HTTP"| serve
    health["Hälsokontroll: GET /health"] --> serve
```

Variabler, proxyns gränser, utgåvor och Dokploy- och Portainer-stegen: [Drift](operations.md).

## Frontendens lager

Pilarna är tillåtna importriktningar: `kit/` importerar bara Astryx, och `lib/` ingen UI-kod.

```mermaid
flowchart TD
    routes["routes: sidor och routetabell"] --> comp["components: skärmar och ytor"]
    routes --> kit["kit: tema, providers, skal"]
    routes --> lib["lib: logik utan UI"]
    comp --> kit
    comp --> lib
    comp --> astryx["Astryx: komponenter, layout, tokens"]
    kit --> astryx
    kit --> theme["kit/theme: Eneo-temat, byggt till statiska filer"]
```

Konventionerna per lager: [Frontend](frontend.md).

## Var organisationens märke och accent kommer in

Märket och accentfärgen är driftsinställningar, inte byggparametrar. Namn och logga läses av backend vid start och skrivs in i sidans markör (`<meta name="eneo-branding">`), som sidan läser före första renderingen; accentfärgen kontrolleras vid start och når sidan som en stilmall som ersätter temats blå.

```mermaid
flowchart LR
    env["ORGANIZATION_NAME, ORGANIZATION_LOGO, SHOW_ORGANIZATION"] --> cfg["backend/app/config.py: läses vid start"]
    envA["ORGANIZATION_ACCENT och ORGANIZATION_ACCENT_DARK"] --> acc["backend/app/accent.py: kontrast minst 4,5:1, annars stoppas start"]
    cfg --> api["/api/branding och /api/branding/logo/light eller dark"]
    acc --> css["/api/branding/theme.css"]
    api --> marker["index.html: backend skriver svaret i markören vid start"]
    marker --> layout["frontend/routes/Root.tsx: läser markören före första renderingen"]
    layout --> ctx["BrandingProvider"]
    ctx --> mark["Brand: logotyp, eller namnet som text"]
    css --> head["index.html: länk i head, ersätter temats accent"]
    theme["kit/theme: standardaccenten #004595"] --> head
```

Hur en annan organisation ställer in det: [Byt organisation](branding.md). Skälen: [beslut 0006](decisions/0006-white-label-branding.md).

## Gränser som inte flyttas

| Gräns | Innebörd | Detaljer |
|---|---|---|
| Credentials | Servicenyckel, modultoken, ticket och signerade fil-URL:er når aldrig webbläsarens JavaScript. | [Inloggning och session](auth-and-session.md#vad-som-aldrig-når-webbläsaren) |
| Same-origin | Webbläsaren anropar bara modulens egen origin; CSP:n tillåter inga andra. | [Backend](backend.md#statiska-filer-och-säkerhetsheaders) |
| Deny by default | BFF:en släpper bara igenom Eneo-rutter och headers som är uppräknade. | [Backend](backend.md#tillåtelselistan-för-eneo-anrop) |
| En process | Sessionslagret är processlokalt: en arbetsprocess, en container. | [Drift](operations.md#driftsätt-med-dokploy-eller-portainer) |
| Inspelningen ligger kvar | Ljudet sparas på enheten medan man spelar in och tas bort först när Eneo har tagit emot körningen. | [Inspelaren](recording.md) |
