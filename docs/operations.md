# Drift

Modulen körs som en image, en process, på port 3001: `python -m app.serve` serverar både gränssnittet och API:t, som vanlig HTTP. TLS slutar framför den. Imagen är `ghcr.io/eneo-ai/eneo-mod-speech-to-text`, och `docker-compose.yml` hämtar och kör den.

## Sätt upp modulen i Eneo

Modulen har inga egna konton: Eneo loggar in användaren, och modulen anropar Eneo med en servicenyckel. Gör det här i Eneo innan du driftsätter ([Eneos modulguide](https://github.com/eneo-ai/eneo/blob/develop/docs/deployment/MODULES.md) har alla steg och felsökning; Eneos gränssnitt är på engelska):

1. **Förutsättningar.** Du behöver en roll med behörigheterna `admin`, `modules` och `api_keys` (rollen Owner har dem), och en Eneo som har sidan **Admin → Modules** och modulinloggningen (`/module-login`). Eneos guide anger inget versionsnummer: kontrollera att sidan finns, och att modulens release uttryckligen stöder Eneos modulinloggning.
2. **Servicenyckel.** Skapa en i **Administration → API keys**: typ `sk_`, ägare `service`, så snäv resursomfattning som möjligt (ofta ett eget space), behörigheten `write` (`admin` bara om modulkontraktet kräver det), med utgångsdatum och rate limit. Kopiera hemligheten direkt, den visas en gång. Den blir `ENEO_API_KEY`, och nyckelns headernamn måste vara samma som Eneos `API_KEY_HEADER_NAME` (`ENEO_API_KEY_HEADER_NAME`, standard `X-API-Key`).
3. **Installera modulen** i **Admin → Modules**: modulnyckeln, en callback-URL per rad och servicenyckeln, och välj **Install module**.
   - Modulnyckeln är `speech-to-text` (`MODULE_KEY`). Eneo skiljer på versaler och gemener och nyckeln kan inte ändras efteråt; modulen kräver gemener i kebab-case.
   - Callback-URL:en är `<MODULE_PUBLIC_URL>/api/auth/callback`: en exakt HTTPS-adress utan jokertecken, som Eneo jämför i schema, värd, port, sökväg och avslutande snedstreck. Registrera produktion och test var för sig.
4. **Modulens miljö:** samma modulnyckel, servicenyckelns hemlighet och en egen, separat genererad `SESSION_SECRET` ([Miljövariabler](#miljövariabler)). Driftsätt sedan.
5. **Användarna** öppnar modulen på dess egen adress (`MODULE_PUBLIC_URL`) och loggar in via Eneo. Prova i ett privat fönster: inloggningen ska gå via Eneo och tillbaka till modulens flödeslista med en ren adress.

Modulen visar de publicerade flöden som användaren har tillgång till. Ett flöde som ska ta emot ljud är publicerat och har ett ljudsteg som tar emot en fil ([Eneo-integration](eneo-integration.md#så-byggs-en-körning)). Utan ett sådant flöde är flödeslistan tom.

## Driftsätt med Dokploy eller Portainer

> [!WARNING]
> **Traefik kapar uppladdningar efter 60 s.** I Traefik v3.7 är `readTimeout` 60 s som standard och gäller hela requesten. Sätt den till minst `1800s` (räcker för 1 GiB över 5 Mbit/s) på `websecure`: [så gör du, fil för fil](#vad-som-står-framför-modulen).

Du behöver två filer från [GitHub-utgåvan](https://github.com/eneo-ai/eneo-mod-speech-to-text/releases): `docker-compose.yml` och `env.example`, som du fyller i och använder som `.env`.

- **Variabler:** de i `.env`. `ENEO_BACKEND_URL`, `ENEO_PUBLIC_URL`, `MODULE_PUBLIC_URL`, `ENEO_API_KEY` och `SESSION_SECRET` måste fyllas i; resten har standardvärden ([Miljövariabler](#miljövariabler)).
- **Dokploy:** skapa ett Compose-projekt, klistra in `docker-compose.yml` och variablerna under Environment, lägg domänen på tjänsten `speech-to-text` med port 3001 och driftsätt. Dokploy och Traefik sköter HTTPS-certifikatet.
- **Portainer:** skapa en stack med Web editor, klistra in `docker-compose.yml` och lägg variablerna under Environment variables. Tjänsten lyssnar på 3001 och publicerar ingen port på värden: en omvänd proxy på samma nätverk når den som `speech-to-text:3001`, och `ports: ["127.0.0.1:3001:3001"]` i stacken gör den nåbar från värden.
- **Image:** paketet ska vara publikt; annars behöver Dokploy eller Portainer en inloggning mot `ghcr.io`.
- **Verifiera:** `<MODULE_PUBLIC_URL>/health` svarar 200, och inloggningen via Eneo leder tillbaka till flödeslistan med en ren adress.

## Uppgradera

Byt `MODULE_VERSION` till den nya taggen (`vX.Y.Z`) och driftsätt om. Med `latest` hämtas ingen ny image om en med det namnet redan finns på värden, så fäst en version. Driftsätt genom att stoppa den gamla containern och sedan starta den nya: sessionerna ligger i processens minne, så två containrar samtidigt skickar personer fel, och alla loggar in igen efter bytet. Att gå tillbaka är att byta tillbaka.

## Miljövariabler

Backend läser miljön en gång vid start (`load_settings` i `backend/app/config.py`); ett ogiltigt värde stoppar starten med ett tydligt fel. Variabler utan standard måste sättas.

| Variabel | Standard | Regel och betydelse |
|---|---|---|
| `MODULE_VERSION` | `latest` | Bara för `docker-compose.yml`: imagens tagg. |
| `ENEO_BACKEND_URL` | | Absolut http(s)-URL utan query eller fragment: dit modulen når Eneos API (`http://backend:8000` på Eneos `module_net`). |
| `ENEO_PUBLIC_URL` | | Eneos publika adress, dit webbläsaren skickas för att logga in. `https`; `http` bara för `localhost`, `127.0.0.1` och `[::1]`, annars stoppas starten. |
| `MODULE_PUBLIC_URL` | | Modulens publika adress. Samma regel som `ENEO_PUBLIC_URL`. Ger callback-URL:en och den tillåtna `Origin`. |
| `MODULE_KEY` | `speech-to-text` i Compose | Gemener i kebab-case. Modulens nyckel i Eneo. |
| `ENEO_API_KEY` | | Modulens servicenyckel (`sk_…`). Secret. |
| `ENEO_API_KEY_HEADER_NAME` | `X-API-Key` | Giltigt HTTP-headernamn som inte är ett credential- eller ramhuvud som modulen sätter själv (`Authorization`, `Cookie`, `Content-Type` med flera). Ska vara samma som Eneos `API_KEY_HEADER_NAME`. |
| `SESSION_SECRET` | | Minst 32 slumpmässiga tecken; `python -c "import secrets; print(secrets.token_urlsafe(48))"`. Signerar login-state. Secret. |
| `COOKIE_SECURE` | `true` | `false` godtas bara när `MODULE_PUBLIC_URL` är `localhost`, `127.0.0.1` eller `[::1]` (lokal utveckling). |
| `SESSION_MAX_AGE_MINUTES` | `480` | Heltal över 0. Övre gräns för en inloggning; det tidigaste av detta och Eneos sessionstak (`MODULE_AUTH_MAX_SESSION_HOURS`) gäller. `docker-compose.yml` skickar inte vidare den, så via den filen gäller standarden. |
| `UPLOAD_PROXY_TIMEOUT_SECONDS` | `1800` | Över 0 och högst 86400: tidsgräns för hela vidarebefordran av en uppladdning. |
| `MAX_BODY_BYTES` | `10485760` (10 MiB) | Tak för varje request-body utom uppladdningar; 413 över taket. |
| `MAX_UPLOAD_BYTES` | `1073741824` (1 GiB) | Tak för hela request-bodyn i en uppladdning (multipart-överhuvud inräknat, så en fil tar något mindre). Höj den om flödena tar emot större ljudfiler. |
| `MAX_RESPONSE_BYTES` | `33554432` (32 MiB) | Mest som läses av ett enskilt svar från Eneo; längre svar blir 502. En fil som strömmas räknas inte. |
| `ORGANIZATION_*`, `SHOW_ORGANIZATION` | tomma, `true` | Namn, logga och accentfärg: [Byt organisation](branding.md). |
| `SPEAKER_REVIEW_ENABLED` | `false` | Byggargument, ingen körningsinställning: den fastställs när imagen byggs (`docker build --build-arg SPEAKER_REVIEW_ENABLED=true`), och en publicerad image har granskningen av. Att skriva talare kräver stöd för v3 i Eneo. |

De tre `MAX_*_BYTES` är heltal från 1 till 2^40; ett värde utanför det stoppar starten. Compose skickar standardvärdena, och ett tomt värde i Compose blir standardvärdet.

## Vad som står framför modulen

Modulen svarar på vanlig HTTP och litar inte på något `X-Forwarded-*`: den läser varken schema, värd eller klientadress. Allt som står framför den hör till driftsättningen och måste ha:

- **HTTPS och HSTS.** Proxyn avslutar TLS och sätter `Strict-Transport-Security`; modulen sätter ingen HSTS. Sessionscookien är `Secure`, och webbläsaren skickar den bara över HTTPS: hela vägen från webbläsaren till proxyn måste vara HTTPS (proxyn talar vanlig HTTP med modulen). Samma krav gäller mikrofonen: webbläsaren ger bara sidor i en säker kontext, alltså HTTPS eller `localhost`, tillgång till den. Hur HSTS sätts i Dokploy och i en annan Traefik: [nedan](#hsts-i-traefik). Kedjan TLS, cookie och inloggning kontrolleras för hand vid driftsättningen.
- **Storlek och tid för uppladdningar.** Gäller Traefik v3.7: varje ingångspunkt har `readTimeout` 60 s, `writeTimeout` 0 (ingen gräns) och `idleTimeout` 180 s. `readTimeout` gäller hela requesten inklusive bodyn, så en uppladdning som tar längre än 60 s att skicka kapas av proxyn, hur snabbt modulen än svarar. Hur du höjer den: [nedan](#höj-readtimeout-i-traefik).
  - Värdet: minst den tid det tar att skicka `MAX_UPLOAD_BYTES` över den långsammaste uppkoppling du räknar med. 1 GiB på 20 Mbit/s tar omkring 7 minuter, och 1800 s räcker för 1 GiB över 5 Mbit/s.
  - `UPLOAD_PROXY_TIMEOUT_SECONDS` är nästa steg och en egen tid: när hela filen är hos modulen får den högst så länge på sig att skicka den vidare till Eneo. Proxyns `writeTimeout` på 0 gör att inget i proxyn kapar den delen.
  - En eventuell `maxRequestBodyBytes` i proxyn ska rymma `MAX_UPLOAD_BYTES`. Svarar modulen 413 medan webbläsaren fortfarande skickar kan en proxy göra det till ett 502.
- **WebSocket.** Uppgraderingen till `/api/live/...` måste släppas igenom, och webbläsarens `Origin` måste komma fram oförändrad. Traefik gör det utan extra konfiguration (v3.7); går `ENEO_BACKEND_URL` via en proxy måste den också släppa igenom uppgraderingar. Traefik v3.7 varnar vid start när `aliasHeadersStrategy` saknas; det är ofarligt för modulen.

- **Rate limiting.** Modulen har ingen egen; behöver du en sätts den i proxyn.

### Höj readTimeout i Traefik

I Dokploy är det två ingångspunkter, `web` och `websecure`, och båda ligger i Traefiks statiska konfiguration, `traefik.yml`:

1. Öppna filen: på servern är den `/etc/dokploy/traefik/traefik.yml`, och i Dokploys panel redigeras den under **Traefik File System**.
2. Lägg `transport` under de `web` och `websecure` som redan finns, och behåll allt annat i dem (`address`, `http`, certifikat):

   ```yaml
   entryPoints:
     web:
       transport:
         respondingTimeouts:
           readTimeout: 1800s
     websecure:
       transport:
         respondingTimeouts:
           readTimeout: 1800s
   ```

3. Starta om Traefik, eftersom en ändring i den statiska konfigurationen inte läses om av sig själv: `docker restart dokploy-traefik`.

En annan Traefik tar samma nycklar i sin `traefik.yml` (`--entryPoints.websecure.transport.respondingTimeouts.readTimeout=1800s` som flagga).

### HSTS i Traefik

Två små filer i Dokploy; HSTS gäller då varje tjänst bakom den Traefik:

1. En middleware i den dynamiska konfigurationen, `/etc/dokploy/traefik/dynamic/hsts.yml` (Traefiks fil-provider läser den katalogen):

   ```yaml
   http:
     middlewares:
       hsts:
         headers:
           stsSeconds: 31536000
   ```

2. Koppla den till `websecure` i `traefik.yml`, bredvid `readTimeout`, och starta om Traefik:

   ```yaml
   entryPoints:
     websecure:
       http:
         middlewares:
           - hsts@file
   ```

Vill du ha HSTS bara för modulen sätter du middleware på modulens router med Compose-etiketter i stället, `traefik.http.middlewares.hsts.headers.stsSeconds=31536000` och `traefik.http.routers.<router>.middlewares=hsts`, där `<router>` är routerns namn i Traefik (Dokploy genererar det för tjänsten).

## Vad en användare behöver

En aktuell Chrome, Edge, Safari eller Firefox och tillstånd till mikrofonen. Fullständig återgivning kräver Chrome eller Edge 125, Safari 26 eller Firefox 147; äldre webbläsare öppnar sidan men placerar menyer och väljare fel. Testerna körs i Chromium, WebKit och Firefox ([Tester](quality-gates.md#produktionstesterna)). Mikrofonen kräver HTTPS (se ovan).

## Uppladdningens tillfälliga lagring

En uppladdning tas emot hel av modulen innan den skickas vidare, och Starlette lägger den i en tillfällig fil så fort den är större än 1 MB. Containern är skrivskyddad, så `/tmp` är den enda skrivbara platsen, och i `docker-compose.yml` är den en volym (`spool`), alltså disk: en tmpfs skulle hålla varje uppladdning i minnet. Filerna tas bort när uppladdningen tar slut eller avbryts. Dimensionera disken, inte minnet: den ska rymma samtidiga uppladdningar × `MAX_UPLOAD_BYTES`. En full disk ger ett fel på uppladdningen, inte på de andra anrop.

## Kapacitet för live-texten

Statiska filer, uppladdningar och live-reläets WebSocket delar en process och en händelseslinga. Mätt på en bärbar dator ryms en live-session och omkring 45 nya besök i sekunden utan märkbar fördröjning i reläet; vid omkring 100 besök i sekunden är processen mättad. Vad ett visst antal besök i sekunden betyder beror på maskinen (en körare med 4 vCPU i GitHub Actions klarar ungefär hälften så många anrop i sekunden), så acceptanskontrollen lägger sina rader som andelar av vad modulen klarar av ett riktigt besök, och "opåverkad" gäller upp till en tredjedel av det. Det är en observation, inget löfte för en annan maskin, och mer kapacitet än en process kräver ett delat sessionslager.

## Inget att säkerhetskopiera

Modulen har ingen databas och ingen volym med data; monteringarna är en valfri, skrivskyddad mapp med en logotyp och uppladdningens tillfälliga lagring. Sessioner ligger i minnet, inspelningar sparas i användarens webbläsare tills Eneo har tagit emot dem, och flöden, körningar och filer ägs av Eneo. Säkerhetskopiera Eneo, inte modulen.

## Eneos modul-overlay

I en Eneo-installation ger Eneos Compose-overlay modulen endast `module_net` och variablerna i tabellen ovan som den behöver, med `ENEO_BACKEND_URL` som `http://backend:8000`. Overlay-filen mappar operatörens secret till `ENEO_API_KEY`. Modulen exponerar port 3001 och hälsokontrollen `/health`.

## Loggar

Modulen loggar till containerns stdout och stderr (`docker logs <container>`, `docker compose logs speech-to-text`). Det finns ingen accesslogg. Den loggar fel och varningar med tydliga etiketter (upstream-fel, misslyckad ticketväxling, en logotyp som inte kunde läsas) men aldrig en token eller en URL med query. Proxyns loggning ska inte heller skriva callbackens query string: den bär en engångsticket.

## CI och utgåvor

`.github/workflows/ci.yml` körs vid pull request och vid push till `main`; arbetsflödena är källan till vad som körs. `docs.yml` bygger `docs-site/` och kör dess webbläsarkontroll, och en push till `main` publicerar sajten till GitHub Pages på `https://eneo-ai.github.io/eneo-mod-speech-to-text/`. Pages måste vara påslaget i repots inställningar, med GitHub Actions som källa.

`release.yml` körs när en tagg `vX.Y.Z` pushas. Den bygger ingenting: den kopierar imagen `sha-<commit>` som CI testade till `vX.Y.Z` och `latest` med samma digest och skapar en GitHub-utgåva med `docker-compose.yml` och `env.example`. En commit som CI inte gått igenom på `main` har ingen image, och taggen misslyckas då: kör jobbet igen när CI är klart.

```
git tag v1.2.3 <commit på main>
git push origin v1.2.3
```

## Uppdatera beroenden och fästa versioner

Allt CI och imagen kör är fäst: backendens paket i en låsfil med hashar, basimagerna vid digest, GitHub Actions vid commit-sha, `docs-site/` till exakta versioner. Inget uppdateras av sig självt, och repot har ingen Dependabot: gör så här, till exempel varje månad och när en sårbarhet rapporteras. Ändra ett steg i taget, kör CI och godkänn imagens acceptans innan nästa. CI stoppar vid fynd i produktionsberoendena (`npm audit` från nivån high, `pip-audit` på låsfilen).

- **Backendens paket:** ändra versionen i `backend/requirements.txt` och generera om låsfilen från repots rot. `backend/tests/test_dependency_lock.py` stoppar en ändring av den ena filen utan den andra.

  ```
  uv pip compile backend/requirements.txt --python-version 3.12 --universal --generate-hashes \
    --exclude-newer <dagens datum>T00:00:00Z -o backend/requirements.lock
  ```

- **Basimagerna** (`Dockerfile`, `deploy/acceptance/compose.yml`, `.github/workflows/`): hämta taggens nya digest och byt den där den står, efter att ha läst versionens ändringslista.

  ```
  docker buildx imagetools inspect node:22-bookworm-slim --format '{{.Manifest.Digest}}'
  ```

- **GitHub Actions:** byt commit-sha och versionskommentaren på varje `uses:`. En ny huvudversion är ett eget beslut.

  ```
  git ls-remote --tags https://github.com/actions/checkout 'refs/tags/v7.*'
  ```

- **Dokumentationssajten:** `npm install --save-exact <paket>@<version>` i `docs-site/`; checka in `package.json` och `package-lock.json`. VitePress och Mermaid byts var för sig.

## Vid problem

| Symptom | Trolig orsak och åtgärd |
|---|---|
| Backend startar inte | Felet säger vilken variabel. En `http`-adress för `MODULE_PUBLIC_URL` eller `ENEO_PUBLIC_URL`, eller `COOKIE_SECURE=false`, stoppar starten om värden inte är `localhost`, `127.0.0.1` eller `[::1]`. Saknas `index.html` i `STATIC_DIR` stoppar starten med mappens namn. |
| Backend startar om i en slinga efter en ändrad accentfärg | `ORGANIZATION_ACCENT` eller `ORGANIZATION_ACCENT_DARK` är inte läsbar nog (under 4,5:1) eller har fel form. Loggen säger vad som mättes: [Byt organisation](branding.md#felmeddelanden-vid-start). |
| Login misslyckas efter callback | Kontrollera exakt registrerad callback-URL, modulnyckel, bunden servicenyckel och att `COOKIE_SECURE=true` bara används bakom HTTPS. Felkoderna: [Inloggning och session](auth-and-session.md#om-callbacken-misslyckas). |
| Mikrofonen går inte att välja | Sidan öppnas inte över HTTPS (eller `localhost`), eller så har webbläsaren nekat tillståndet. |
| Uppladdningen misslyckas | Svaret säger varför. 413: `max_body_bytes` (JSON-anrop) eller `max_upload_bytes` (uppladdning), höj rätt variabel; ett 413 utan det namnet är Eneos egen gräns. 411: en klient som skickar bodyn utan `Content-Length`, till exempel en proxy som skickar i delar. 504: vidarebefordran till Eneo tog längre än `UPLOAD_PROXY_TIMEOUT_SECONDS`. 502: `upstream_unreachable` (Eneo nåddes inte, ofta ett lastbalanserarproblem: kolla loggen efter det exakta httpx-felet), `upstream_too_large`, `upstream_redirect` (Eneo omdirigerade, vilket modulen aldrig följer) eller `upstream_invalid` på en fil (Eneos svar på begäran om en signerad URL gick inte att använda). |
| Uppladdningen faller efter lång tid | Proxyns `readTimeout` (60 s som standard i Traefik v3.7) är kortare än uppladdningen: [Vad som står framför modulen](#vad-som-står-framför-modulen). |
| "Det gick inte att skicka" under uppladdningen | Eneo svarade med serverfel på fyra försök att ladda upp samma fil (nätavbrott och 429 räknas inte). Inspelningen ligger kvar i webbläsaren och kan skickas igen med "Försök igen" ([Inspelaren](recording.md#uppladdning-och-nya-försök)). |
| Tom flödeslista | Användaren är inte medlem i något space med publicerade flöden, eller modulnyckelns space scope utesluter dem. |
| En gammal färg visas efter ett byte | Accentens stilmall får cachas i fem minuter. Ladda om sidan eller öppna den i ett privat fönster. |
| "Sidan kunde inte visas." | En flik som stått öppen över en ny version frågar efter filer som inte finns. "Ladda om sidan". |
| Alla blir utloggade | Containern startade om: sessionslagret är processlokalt. |
