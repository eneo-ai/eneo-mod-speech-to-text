# Drift

Modulen körs som en image, en process, på port 3001: `python -m app.serve` serverar både gränssnittet och API:t, som vanlig HTTP. TLS slutar framför den. Imagen är `ghcr.io/eneo-ai/eneo-mod-speech-to-text`, och `docker-compose.yml` hämtar och kör den.

## Driftsätt med Dokploy eller Portainer

Du behöver två filer från [GitHub-utgåvan](https://github.com/eneo-ai/eneo-mod-speech-to-text/releases): `docker-compose.yml` och `env.example`, som du fyller i och använder som `.env`.

- **Image:** taggen väljs med `MODULE_VERSION` (en tagg `vX.Y.Z`, eller `latest` för den senaste utgåvan). Paketet ska vara publikt; annars behöver Dokploy eller Portainer en inloggning mot `ghcr.io`.
- **Variabler:** de i `.env`. `ENEO_BACKEND_URL`, `ENEO_PUBLIC_URL`, `MODULE_PUBLIC_URL`, `ENEO_API_KEY` och `SESSION_SECRET` måste fyllas i; resten har standardvärden ([Miljövariabler](#miljövariabler)).
- **Dokploy:** skapa ett Compose-projekt, klistra in `docker-compose.yml` och variablerna under Environment, lägg domänen på tjänsten `speech-to-text` med port 3001 och driftsätt. Dokploy och Traefik sköter HTTPS-certifikatet.
- **Portainer:** skapa en stack med Web editor, klistra in `docker-compose.yml` och lägg variablerna under Environment variables. Tjänsten lyssnar på 3001 och publicerar ingen port på värden: en omvänd proxy på samma nätverk når den som `speech-to-text:3001`, och `ports: ["127.0.0.1:3001:3001"]` i stacken gör den nåbar från värden.
- **Containern** är skrivskyddad, utan Linux-capabilities och utan nya privilegier, med en skrivbar volym för uppladdningar ([Uppladdningens tillfälliga lagring](#uppladdningens-tillfälliga-lagring)), och startas om om den dör. Hälsokontrollen frågar `/health`.
- **Verifiera:** `https://<MODULE_PUBLIC_URL>/health` svarar 200, och inloggningen via Eneo leder tillbaka till flödeslistan med en ren adress. Ingress- eller Traefik-loggning måste utesluta callbackens query string (den bär en engångsticket).
- **Uppgradera:** byt `MODULE_VERSION` till den nya taggen och driftsätt om. Med `latest` hämtas ingen ny image om en med det namnet redan finns på värden, så fäst en version. Att gå tillbaka är att byta tillbaka.
- **En container i taget.** Sessionerna ligger i processens minne, så två containrar samtidigt skickar personer fel. Driftsätt genom att stoppa den gamla och sedan starta den nya; alla loggar då in igen. Inga repliker, och en arbetsprocess: `python -m app.serve` fixerar det och är det enda sättet att starta backenden.

## Miljövariabler

Backend läser miljön en gång vid start (`load_settings` i `backend/app/config.py`); ett ogiltigt värde stoppar starten med ett tydligt fel. Variabler utan standard måste sättas.

| Variabel | Standard | Regel och betydelse |
|---|---|---|
| `MODULE_VERSION` | `latest` | Bara för `docker-compose.yml`: imagens tagg. |
| `ENEO_BACKEND_URL` | | Absolut http(s)-URL utan query eller fragment: dit modulen når Eneos API (`http://backend:8000` på Eneos `module_net`). |
| `ENEO_PUBLIC_URL` | | Eneos publika adress, dit webbläsaren skickas för att logga in. `https`; `http` bara för `localhost`, `127.0.0.1` och `[::1]`, annars stoppas starten. |
| `MODULE_PUBLIC_URL` | | Modulens publika adress. Samma regel som `ENEO_PUBLIC_URL`. Ger callback-URL:en och den tillåtna `Origin`. |
| `MODULE_KEY` | `speech-to-text` i Compose | Gemener i kebab-case. Modulens nyckel i Eneo. |
| `ENEO_API_KEY` | | Modulens servicenyckel (`sk_…`) med rätt space-scope. Secret. |
| `ENEO_API_KEY_HEADER_NAME` | `X-API-Key` | Giltigt HTTP-headernamn som inte är ett credential- eller ramhuvud som modulen sätter själv (`Authorization`, `Cookie`, `Content-Type` och de andra i `_RESERVED_HEADER_NAMES`). Ska vara samma som Eneos `API_KEY_HEADER_NAME`. |
| `SESSION_SECRET` | | Minst 32 slumpmässiga tecken; `python -c "import secrets; print(secrets.token_urlsafe(48))"`. Signerar login-state. Secret. |
| `COOKIE_SECURE` | `true` | `true`, `false`, `1`, `0`, `yes`, `no`, `on` eller `off`. `false` godtas bara när `MODULE_PUBLIC_URL` är `localhost`, `127.0.0.1` eller `[::1]` (lokal utveckling). |
| `SESSION_MAX_AGE_MINUTES` | `480` | Heltal över 0. Övre gräns för en inloggning; det tidigaste av detta och Eneos sessionstak (`MODULE_AUTH_MAX_SESSION_HOURS`) gäller. `docker-compose.yml` skickar inte vidare den, så via den filen gäller standarden. |
| `UPLOAD_PROXY_TIMEOUT_SECONDS` | `1800` | Ett ändligt antal sekunder, över 0 och högst 86400: tidsgräns för hela vidarebefordran av en uppladdning. |
| `MAX_BODY_BYTES` | `10485760` (10 MiB) | Tak för varje request-body utom uppladdningar; 413 över taket. |
| `MAX_UPLOAD_BYTES` | `1073741824` (1 GiB) | Tak för hela request-bodyn i en uppladdning (multipart-överhuvud inräknat, så en fil tar något mindre). Höj den om flödena tar emot större ljudfiler. |
| `MAX_RESPONSE_BYTES` | `33554432` (32 MiB) | Mest som läses av ett enskilt svar från Eneo; längre svar blir 502. En fil som strömmas räknas inte. |
| `ORGANIZATION_NAME`, `ORGANIZATION_LOGO`, `ORGANIZATION_LOGO_DARK`, `SHOW_ORGANIZATION`, `ORGANIZATION_ACCENT`, `ORGANIZATION_ACCENT_DARK` | tomma, `true` | Namn, logga och accentfärg. Utan dem visas Sundsvalls kommun och modulens standardblå. En accentfärg som inte når 4,5:1 mot sidans ytor stoppar starten. [Byt organisation](branding.md) |
| `STATIC_DIR` | `/app/web` i imagen | Mappen med det byggda gränssnittet. Sätts av imagen; utan den (och utan `--api-only`) vägrar starten. |
| `SPEAKER_REVIEW_ENABLED` | `false` | Byggargument, ingen körningsinställning: den fastställs när imagen byggs (`docker build --build-arg SPEAKER_REVIEW_ENABLED=true`, eller `docker compose build` med variabeln satt), och en publicerad image har granskningen av. Att sätta den för en publicerad image gör ingenting. Att skriva talare kräver stöd för v3 i Eneo. |
| `DEV_API_BASE` | `http://127.0.0.1:8000` | Bara för Vites utvecklingsserver: dit `/api` och `/health` proxas. |

`MAX_BODY_BYTES`, `MAX_UPLOAD_BYTES` och `MAX_RESPONSE_BYTES` är heltal från 1 till 2^40; ett värde utanför det stoppar starten. Compose skickar standardvärdena, och ett tomt värde i Compose blir standardvärdet. Variablerna som finns är de som `backend/app/config.py` läser.

## Vad som står framför modulen

Modulen svarar på vanlig HTTP och litar inte på något `X-Forwarded-*`: den läser varken schema, värd eller klientadress. Allt som står framför den hör till driftsättningen och måste ha:

- **HTTPS.** `MODULE_PUBLIC_URL` och `ENEO_PUBLIC_URL` är `https` och sessionscookien är `Secure`. Kedjan TLS, cookie och inloggning kontrolleras för hand vid driftsättningen.
- **Storlek och tid för uppladdningar.** `MAX_UPLOAD_BYTES` begränsar hela request-bodyn. Framför den står proxyns egna gränser, som är driftsättningens: Traefiks läs- och tomgångstidsgränser på ingångspunkten (`readTimeout` ska vara längre än `UPLOAD_PROXY_TIMEOUT_SECONDS`; Traefiks standard är ingen läs- eller skrivgräns och 180 s tomgång) och en eventuell `maxRequestBodyBytes`. En uppladdning på `MAX_UPLOAD_BYTES` och en lång live-session måste rymmas inom dem. Svarar modulen 413 medan webbläsaren fortfarande skickar kan en proxy göra det till ett 502.
- **WebSocket.** Uppgraderingen till `/api/live/...` måste släppas igenom, och webbläsarens `Origin` måste komma fram oförändrad. Traefik gör det utan extra konfiguration (v3.7, se [Eneo-integration](eneo-integration.md#live-text-strömma)); går `ENEO_BACKEND_URL` via en proxy måste den också släppa igenom uppgraderingar. Traefik v3.7 varnar vid start när `aliasHeadersStrategy` saknas; det är ofarligt för modulen.
- **Loggar.** Ingressens loggning ska inte skriva callbackens query string.

## Uppladdningens tillfälliga lagring

En uppladdning tas emot hel av modulen innan den skickas vidare: Starlette lägger den i en tillfällig fil så fort den är större än 1 MB. Containern är skrivskyddad, så `/tmp` är den enda skrivbara platsen, och i `docker-compose.yml` är den en volym (`spool`), alltså disk, inte en tmpfs. Volymen innehåller inga data att spara: filerna tas bort när uppladdningen tar slut eller avbryts.

Skälet är mätt. En 1 GiB-uppladdning till en container med 300 MB minne: med en tmpfs på `/tmp` dödas containern av minnesbristen (OOM, exitkod 137); med en volym går uppladdningen igenom och processens eget minne växer med 4 MB. Dimensionera därför disken, inte minnet: den ska rymma samtidiga uppladdningar × `MAX_UPLOAD_BYTES`. Modulen begränsar inte antalet samtidiga uppladdningar, och en full disk ger ett fel på uppladdningen, inte på de andra anropen.

## Kapacitet för live-texten

Statiska filer, uppladdningar och live-reläets WebSocket delar en process och en händelseslinga. Mätt på en bärbar dator med OrbStack och lastgeneratorn på samma dator, med en live-session som strömmar 20 bildrutor i sekunden och N besök i sekunden som hämtar vad en webbläsare hämtar vid ett kallt besök av ett flöde (32 anrop): vid 45 besök i sekunden (1 440 anrop/s) är reläets p95-fördröjning 1,1 till 1,2 ms, mot 2,7 till 3,8 ms utan last. Vid 100 besök i sekunden är modulen vid mättnad och p95 22 till 63 ms. Med 200 klienter som hämtar utan paus klarar modulen 4 000 till 4 400 anrop/s och p95 är 3,6 till 6,7 gånger så hög som utan last; det är en observation på en dator, inget löfte för en annan maskin. Vad ett visst antal besök i sekunden betyder beror på maskinen: en körare med 4 vCPU i GitHub Actions klarar ungefär hälften så många anrop i sekunden som den bärbara datorn, så acceptanskontrollen lägger sina rader som andelar (10, 35 och 80 procent) av vad modulen klarar av ett riktigt besök, och "opåverkad" gäller upp till en tredjedel av det. Mer kapacitet än en process kräver ett delat sessionslager.

## Inget att säkerhetskopiera

Modulen har ingen databas och ingen volym med data; monteringarna är en valfri, skrivskyddad mapp med en logotyp och uppladdningens tillfälliga lagring. Sessioner ligger i minnet, inspelningar sparas i användarens webbläsare tills Eneo har tagit emot dem, och flöden, körningar och filer ägs av Eneo. Säkerhetskopiera Eneo, inte modulen.

## Eneos modul-overlay

I en Eneo-installation ger Eneos Compose-overlay modulen endast `module_net` och variablerna `ENEO_BACKEND_URL` (`http://backend:8000`), `ENEO_PUBLIC_URL`, `MODULE_PUBLIC_URL`, `MODULE_KEY`, `ENEO_API_KEY` (en modulspecifik `sk_`-nyckel), `ENEO_API_KEY_HEADER_NAME` och `SESSION_SECRET`. Modulen exponerar port 3001 och hälsokontrollen `/health`. Overlay-filen mappar operatörens secret till `ENEO_API_KEY`.

## Loggar

Modulen loggar till containerns stdout och stderr (`docker logs <container>`, `docker compose logs speech-to-text`). Det finns ingen accesslogg. Den loggar fel och varningar med tydliga etiketter (till exempel upstream-fel, misslyckad ticketväxling, en logotyp som inte kunde läsas) men aldrig en token eller en URL med query ([Backend](backend.md#svar-från-eneo)).

## CI och utgåvor

`.github/workflows/ci.yml` körs vid pull request och vid push till `main`:

| Jobb | Vad |
|---|---|
| `backend` | Installerar `backend/requirements.lock` med hashar, kör backendens tester, den falska Eneos egna tester och acceptansskriptens egna tester, och `pip-audit` på låsfilen (Python 3.12). |
| `frontend` | `npm ci`, `npm test`, `npm run lint`, `npm run astryx -- doctor`, kontroll att det byggda temat är aktuellt (`npm run theme:build` och `git diff --exit-code -- kit/theme/built`), `npm audit --omit=dev --audit-level=high`, `npm run build` (Node 22). |
| `frontend-browser` | `npm run test:prod` i tre motorer, gatens projekt `phone-390-light` och `laptop-1440-light`, och branding-tillstånden i `laptop-1440-light` och `phone-390-dark`. |
| `compose` | `docker compose config -q` för `docker-compose.yml` ensam (filen en operatör klistrar in) och sammanslagen med utvecklarens override. |
| `image` | Bygger imagen en gång, med SBOM och provenance, kör imagens acceptans ([Tester](quality-gates.md#imagens-acceptans)) på just det bygget efter digest, och sparar den testade imagen som arkiv. |
| `publish` | Efter att alla jobb ovan gått igenom på samma commit, bara för `main`: `publish.yml` kopierar arkivet (samma digest som acceptansen såg) till `ghcr.io/eneo-ai/eneo-mod-speech-to-text:sha-<commit>` och kontrollerar digesten. Den bygger aldrig. |

**Utgåva.** `.github/workflows/release.yml` körs när en tagg `vX.Y.Z` pushas. Den bygger ingenting: den kopierar imagen `sha-<commit>` som CI testade till taggarna `vX.Y.Z` och `latest` med samma digest, kontrollerar digesten efter varje kopiering och skapar en GitHub-utgåva där `docker-compose.yml` och `env.example` är bifogade. En commit som CI inte gått igenom på `main` har ingen image, och taggen misslyckas då: kör jobbet igen när CI är klart.

```
git tag v1.2.3 <commit på main>
git push origin v1.2.3
```

## Uppdatera beroenden och fästa versioner

Allt CI och imagen kör är fäst: backendens paket i en låsfil med hashar, basimagerna vid digest, GitHub Actions vid commit-sha. Inget uppdateras av sig självt; gör så här, till exempel varje månad och när en sårbarhet rapporteras. Ändra ett steg i taget, kör CI och godkänn imagens acceptans innan nästa.

**Backendens paket.** `backend/requirements.txt` nämner de direkta paketen med exakta versioner; `backend/requirements.lock` är alla paket, med hashar, genererad ur den. Ändra en version i `requirements.txt` och generera om låsfilen från repots rot:

```
uv pip compile backend/requirements.txt --python-version 3.12 --universal --generate-hashes \
  --exclude-newer <dagens datum>T00:00:00Z -o backend/requirements.lock
```

Checka in båda filerna. `backend/tests/test_dependency_lock.py` stoppar en ändring av den ena utan den andra, och en Dockerfile eller ett CI-steg som inte installerar låsfilen med `--require-hashes`.

**Basimagerna.** `node:22-bookworm-slim` och `python:3.12-slim` (i `Dockerfile`, och `python:3.12-slim` även i `deploy/acceptance/compose.yml`), `traefik` (`deploy/acceptance/compose.yml`), `registry` och skopeo (`.github/workflows/`). Hämta taggens nya digest och byt den där den står:

```
docker buildx imagetools inspect node:22-bookworm-slim --format '{{.Manifest.Digest}}'
```

Node-bygget kör `npm ci --engine-strict`, så en bas som inte når `engines` i `frontend/package.json` stoppar bygget. Byt en versionsrad (till exempel `traefik:v3.7.13`) först efter att ha läst versionens ändringslista.

**GitHub Actions.** Varje `uses:` är ett commit-sha med versionen i kommentaren. Hitta den senaste utgåvan av samma huvudversion och commit-shan som taggen pekar på (för en annoterad tagg raden med `^{}`):

```
git ls-remote --tags https://github.com/actions/checkout 'refs/tags/v7.*'
```

Byt sha och kommentar. En ny huvudversion är ett eget beslut: läs dess ändringslista först.

## Beroendesäkerhet

Kända sårbarheter hanteras manuellt: repot har ingen `.github/dependabot.yml`, så inga dependency-PR:er skapas av sig själva. CI stoppar vid fynd i produktionsberoendena: `npm audit` för frontend (från nivån high) och `pip-audit` för backends låsfil, alltså de Python-paket imagen innehåller (alla kända sårbarheter).

## Vid problem

| Symptom | Trolig orsak och åtgärd |
|---|---|
| Backend startar inte | Felet säger vilken variabel. En `http`-adress för `MODULE_PUBLIC_URL` eller `ENEO_PUBLIC_URL`, eller `COOKIE_SECURE=false`, stoppar starten om värden inte är `localhost`, `127.0.0.1` eller `[::1]`. Saknas `index.html` i `STATIC_DIR` stoppar starten med mappens namn. |
| Backend startar om i en slinga efter en ändrad accentfärg | `ORGANIZATION_ACCENT` eller `ORGANIZATION_ACCENT_DARK` är inte läsbar nog (under 4,5:1) eller har fel form. Loggen säger vad som mättes: [Byt organisation](branding.md#felmeddelanden-vid-start). |
| Login misslyckas efter callback | Kontrollera exakt registrerad callback-URL, module key, bunden servicenyckel och att `COOKIE_SECURE=true` bara används bakom HTTPS. Felkoderna: [Inloggning och session](auth-and-session.md#om-callbacken-misslyckas). |
| 502 vid uppladdning | Svaret säger varför: `upstream_unreachable` (Eneo nåddes inte, ofta ett lastbalanserarproblem: kolla loggen efter det exakta httpx-felet), `upstream_too_large` (Eneos svar var längre än `MAX_RESPONSE_BYTES` eller kodat) eller `upstream_redirect` (Eneo omdirigerade, vilket modulen aldrig följer). Ett 502 mitt i en uppladdning kan också vara proxyn som avbrutit den. |
| 502 `upstream_invalid` på en fil | Eneos svar på begäran om en signerad URL gick inte att använda. Loggen har vägen. |
| 504 vid uppladdning | Vidarebefordran till Eneo tog längre än `UPLOAD_PROXY_TIMEOUT_SECONDS`. |
| Uppladdningen faller efter lång tid | Proxyns tidsgräns före modulen är kortare än uppladdningen: [Vad som står framför modulen](#vad-som-står-framför-modulen). |
| "Det gick inte att skicka" under uppladdningen | Eneo svarade med serverfel på fyra försök att ladda upp samma fil (nätavbrott och 429 räknas inte). Inspelningen ligger kvar i webbläsaren och kan skickas igen med "Försök igen" ([Inspelaren](recording.md#uppladdning-och-nya-försök)). |
| 413 | Ett tak för body nåddes. Svaret säger vilket: `max_body_bytes` (JSON-anrop) eller `max_upload_bytes` (uppladdning). Höj rätt variabel om gränsen är för snäv. Ett 413 utan det namnet är Eneos egen gräns. |
| 411 vid uppladdning | En uppladdning utan `Content-Length`. Webbläsare skickar alltid en; en annan klient, eller en proxy som skickar bodyn i delar, är orsaken. |
| Tom flödeslista | Användaren är inte medlem i något space med publicerade flöden, eller modulnyckelns space scope utesluter dem. |
| En gammal färg visas efter ett byte | Accentens stilmall får cachas i fem minuter. Ladda om sidan eller öppna den i ett privat fönster. |
| "Sidan kunde inte visas." | En flik som stått öppen över en ny version frågar efter filer som inte finns. "Ladda om sidan". |
| Alla blir utloggade | Containern startade om: sessionslagret är processlokalt. |
