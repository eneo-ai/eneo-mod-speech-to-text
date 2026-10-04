# Arkitektur

Syfte: Visa hur modulen är byggd, vilka delar som pratar med vilka och var gränserna för inloggning, filer och utseende går.

Läs detta när: Du är ny i koden, ska ändra något som korsar webbläsare, frontend, backend och Eneo, eller ska förklara systemet för någon annan.

Hör ihop med: [Inloggning och session](auth-and-session.md), [Backend](backend.md), [Frontend](frontend.md), [Drift](operations.md), [Beslut](decisions/README.md), [Ordlista](glossary.md)

## Översiktsbild

![Översiktsbild. Till vänster Webbläsare (en person vid en laptop och en telefon) som med en pil och en cookie når Modulen i mitten. Modulen har två kort: Gränssnitt (en mikrofon och en ljudvåg) och Säker backend (en sköld med hänglås och en nyckel). En pil med en nyckel och ett personmärke går från Modulen till Eneo till höger (ett flödesschema och ett dokument), och en tunnare pil med ett dokument går tillbaka. Ovanför Modulen sitter en list: Egen logga, namn och färg.](images/arkitektur-oversikt.png)

Bilden är illustrativ och ger överblicken. Mermaid-diagrammen längre ned är den beskrivning som gäller; om bilden och ett diagram skiljer sig åt är diagrammet rätt.

## Delarna

| Del | Vad den gör | Var den finns |
|---|---|---|
| Webbläsaren | Spelar in ljud, visar gränssnittet, talar bara same-origin med modulen. Har aldrig Eneos credentials. | körs från `frontend/` |
| Next.js | Serverar gränssnittet och skickar vidare allt under `/api/*` (och `/health`) till BFF:en med en rewrite. Sätter säkerhetsheaders. | `frontend/` (`next.config.mjs`) |
| BFF (FastAPI) | Håller modulsessionen, loggar in mot Eneo, lägger servicenyckel och modultoken på varje anrop, släpper bara igenom tillåtna Eneo-rutter, strömmar filer, relayar live-text. | `backend/app/` |
| Eneo | Autentiserar användaren och äger flöden, körningar och filer. | utanför det här repot |

## Läget i dag

| Status | Vad |
|---|---|
| Nuvarande | Next.js 16 är frontend-servern och FastAPI ligger internt bakom den. De körs i en image under supervisord (port 3001), eller som två containrar i Compose. Gränssnittet är på väg över till Astryx (se Migration nedan). |
| Planerat | Plan B: gränssnittet byggs som statiska filer och serveras av FastAPI, så att Next.js-servern, rewrite-hoppet och supervisord försvinner (en process). Plan C: ett delat modulkit i ett eget repo, `eneo-ai/eneo-module-kit`, som den här modulen senare flyttar över på. Plan B är inte påbörjat och väntar på ägarens besked; inget av detta är byggt här. |

Uppgifter och diagram nedan beskriver nuläget om inget annat sägs: Next.js är frontend-servern, och först Plan B skulle ta bort den.

## Systemkontext

Följ pilarna: webbläsaren pratar bara med modulen, modulens backend pratar med Eneo, och webbläsaren skickas till Eneo bara för att logga in.

```mermaid
flowchart LR
    user["Användare i webbläsaren"]
    subgraph module["Modulen: en container, port 3001"]
        next["Next.js: gränssnitt och /api-rewrite"]
        api["FastAPI: BFF på 127.0.0.1:8000"]
    end
    eneo["Eneo: inloggning, flöden, körningar, filer"]
    user -->|"HTTPS, same-origin"| next
    next -->|"rewrite /api/*"| api
    api -->|"servicenyckel och modultoken"| eneo
    user -.->|"omdirigeras vid inloggning"| eneo
```

## Inloggningen

Titta på vem som håller i vad: ticketen går via webbläsaren men växlas mot en token bara av BFF:en, och sessionscookien är ett slumpmässigt ID.

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

Stegen i ord, felkoder, förnyelse och åtkomstkodsläget står i [Inloggning och session](auth-and-session.md).

## Ett proxat anrop

Följ kontrollerna uppifrån och ned: ett anrop till Eneo når bara fram om det klarar taket, session, origin, sidans användare och tillåtelselistan, och bara några få av webbläsarens headers och modulens egna credentials går vidare.

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
    user -->|"ja"| route{"Tillåten metod och sökväg, utan punktsegment, ?, # eller kontrolltecken?"}
    route -->|"nej"| r403b["403 Eneo resource is not exposed"]
    route -->|"ja"| hdr["Bara tillåtna headers går vidare, modulens credentials läggs på, varje sökvägssegment kodas"]
    hdr --> up["httpx mot Eneo /api/v1/..., svaret räknas medan det kommer"]
    up -->|"nätverksfel"| r502a["502 upstream_unreachable"]
    up -->|"längre än MAX_RESPONSE_BYTES, eller kodat"| r502b["502 upstream_too_large"]
    up -->|"omdirigering"| r502c["502 upstream_redirect"]
    up -->|"svar"| resp["Svaret tillbaka utan Set-Cookie, Location och hop-by-hop-headers"]
```

Allowlisten, headrarna, gränserna och testerna beskrivs i [Backend](backend.md).

## Uppladdning och signerade filer

Först uppladdningen: filen går genom Next-hoppet och byggs om av BFF:en, som läser den först efter att den kontrollerat vem som skickar.

```mermaid
flowchart LR
    b["Webbläsare"] -->|"POST multipart, same-origin"| n["Next.js rewrite"]
    n -->|"klonar bodyn i minnet: tak 2 GB, tystnadsgräns 31 min"| mw{"Content-Length över MAX_UPLOAD_BYTES?"}
    mw -->|"ja"| e413["413 max_upload_bytes"]
    mw -->|"nej"| chk{"Modulsession, Origin och sidans användare ok?"}
    chk -->|"nej"| e4["401, 403 eller 409"]
    chk -->|"ja"| rd["Läser filen: 411 utan Content-Length, 400 om bodyn inte är exakt en fil upload_file"]
    rd --> p["httpx bygger om multipart ur filen"]
    p -->|"servicenyckel och modultoken, inom UPLOAD_PROXY_TIMEOUT_SECONDS i sin helhet"| eneo["Eneo: runtime-files"]
    p -->|"tidsgränsen går ut"| t["504 upstream_upload_timeout"]
    p -->|"nätverksfel"| u["502 upstream_unreachable"]
```

Sedan filer ut ur Eneo: webbläsaren får aldrig Eneos signerade URL, BFF:en hämtar den och strömmar bytes med Range intakt, och bara typer som inte kan köra skript öppnas inline.

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

Två sätt att köra samma kod: en image med båda processerna, och två containrar i Compose. Bara tjänsten som tar emot trafik exponeras.

```mermaid
flowchart LR
    subgraph image["Produktionsimage: en container, port 3001"]
        sup["supervisord"]
        node["Next.js: node server.js"]
        uv["uvicorn: FastAPI på 127.0.0.1:8000"]
        sup --> node
        sup --> uv
        node -->|"rewrite /api/*"| uv
    end
    subgraph compose["Compose: två containrar"]
        fe["frontend, port 3000"]
        be["speech-to-text-backend, port 8000, bara internt"]
        fe -->|"INTERNAL_API_BASE"| be
    end
    eneonet["Eneos module_net och ingress"] --> node
    dokploy["Dokploy och Traefik"] --> fe
```

Portar, miljövariabler, healthchecks och Dokploy-stegen står i [Drift](operations.md).

## Frontendens lager

Pilarna är tillåtna importriktningar. `kit/` importerar inget från `app/`, `components/` eller `lib/`, och `lib/` importerar ingen UI-kod.

```mermaid
flowchart TD
    app["app: routes och sidor"] --> comp["components: skärmar och ytor"]
    app --> kit["kit: tema, providers, skal"]
    app --> lib["lib: logik utan UI"]
    comp --> kit
    comp --> lib
    comp --> astryx["Astryx: komponenter, layout, tokens"]
    kit --> astryx
    kit --> theme["kit/theme: Eneo-temat, byggt till statiska filer"]
```

Konventionerna per lager står i [Frontend](frontend.md) och [Designsystem](design-system.md).

## Var organisationens märke och accent kommer in

Märket och accentfärgen är driftsinställningar, inte byggparametrar. Namn och logga läses av backend vid start och skrivs in i sidans markör (`<meta name="eneo-branding">`), som sidan läser före första renderingen; accentfärgen kontrolleras vid start och når sidan som en stilmall som ersätter temats blå. Allt annat i utseendet följer modulens tema.

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

Hur en annan organisation ställer in det: [Byt organisation](branding.md). Beslutet och skälen: [0006](decisions/0006-white-label-branding.md).

## Gränser som inte flyttas

| Gräns | Innebörd | Detaljer |
|---|---|---|
| Credentials | Servicenyckel, modultoken, ticket och signerade fil-URL:er når aldrig webbläsarens JavaScript. | [Inloggning och session](auth-and-session.md#vad-som-aldrig-når-webbläsaren) |
| Same-origin | Webbläsaren anropar bara modulens egen origin; CSP:n tillåter inga andra. | `frontend/next.config.mjs` |
| Deny by default | BFF:en släpper bara igenom Eneo-rutter som är uppräknade. | [Backend](backend.md#tillåtelselistan-för-eneo-anrop) |
| En replik | Sessionslagret är processlokalt: kör en backendprocess. | [Drift](operations.md#sessionslagret-är-processlokalt) |
| Inspelningen ligger kvar | Ljudet sparas på enheten medan man spelar in och tas bort först när Eneo har tagit emot körningen. | [Inspelaren](recording.md) |

## Migration (temporary, removed by bead .24)

Gränssnittet har porterats från shadcn/Radix/Tailwind till Astryx; de två systemen samexisterar inte längre:

- Läget och planen: `docs/plans/2026-10-01-astryx-port-plan.md`; beslutsunderlaget: `docs/plans/2026-10-01-module-platform-design.md`.
- Det gamla systemet (`frontend/components/ui/`, Tailwind och dess konfiguration, `frontend/lib/utils.ts`, Radix) är borttaget. `frontend/lib/legacy-ui.test.ts` misslyckas om en import av det eller en klasssträng kommer tillbaka.
- Plan A (portningen) går före Plan B och C ovan; de två senare beslutas separat.
