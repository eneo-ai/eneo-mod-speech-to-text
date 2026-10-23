# Drift

Modulen är en image, `ghcr.io/eneo-ai/eneo-mod-speech-to-text`, och en process som serverar både gränssnittet och API:t på port 3001 över vanlig HTTP. TLS avslutas framför den. Första uppsättningen, med kopplingen till Eneo: [Kom igång](kom-igang.md). Den här sidan är referensen.

## Driftsätt med Dokploy eller Portainer

Ladda ner `docker-compose.yml` och `env.example` från [GitHub-utgåvan](https://github.com/eneo-ai/eneo-mod-speech-to-text/releases) och fyll i `env.example` som `.env` ([Kom igång, steg 4](kom-igang.md#4-kör-modulen)).

- **Dokploy:** skapa ett Compose-projekt, klistra in `docker-compose.yml` och variablerna under Environment, lägg domänen på tjänsten `speech-to-text` med port 3001 och driftsätt. Dokploy och dess Traefik sköter HTTPS-certifikatet. [Höj `readTimeout`](#höj-readtimeout-i-traefik).
- **Portainer:** skapa en stack med Web editor, klistra in `docker-compose.yml` och lägg variablerna under Environment variables. Tjänsten publicerar ingen port på värden: en omvänd proxy på samma nätverk når den som `speech-to-text:3001`, och `ports: ["127.0.0.1:3001:3001"]` i stacken gör den nåbar från värden.
- **Ingen omvänd proxy på värden:** `docker-compose.traefik.yml` i repot lägger Traefik med Let's Encrypt, HSTS och `readTimeout` 1800 s framför modulen. Sätt `MODULE_HOST` (och `MODULE_PUBLIC_URL=https://<MODULE_HOST>`) och `ACME_EMAIL` i `.env`, låt port 80 och 443 nå värden och kör `docker compose -f docker-compose.yml -f docker-compose.traefik.yml up -d`. Dokploy har redan en Traefik och ska inte ha filen.
- **Imagen:** paketet på `ghcr.io` ska vara publikt; annars behöver Dokploy eller Portainer en inloggning mot registret.

## Acceptans innan verklig användning

CI prövar imagen mot en stubbe som spelar Eneo ([Tester](quality-gates.md#imagens-acceptans)), inte er driftsmiljö. Driftsätt därför en ny version med testkonton i egna ytor, gör kontrollerna nedan på den riktiga domänen mot det riktiga Eneo och släpp sedan in verklig användning på samma container. En omstart till bevisar inget och loggar ut alla. Anteckna utfallet där driftsättningen följs upp.

- **Inloggningen** går via Eneo och tillbaka till flödeslistan med en ren adress, i ett privat fönster.
- **Eneos behörighet:** två testkonton i två ytor, med egna flöden och körningar. Varje konto når sitt eget, och inget konto når det andras flöden, körningar, filer, resultat, granskningar eller livesessioner genom modulens adresser. Ett nekat anrop mot något som inte finns bevisar inget.
- **TLS och cookies:** HTTPS och HSTS från proxyn, sessionscookien `Secure` och `HttpOnly`, modulens headers på plats (`curl -sI <MODULE_PUBLIC_URL>/`).
- **Proxyn och uppladdningen:** ladda upp en fil strax under `MAX_UPLOAD_BYTES` från webbläsaren över den långsammaste anslutning ni lovar, med ett avbrott och en återupptagning på vägen. En fil över taket ska få 413. Den återupptagbara rutten reserverar 4 096 byte under taket, så en fil på exakt taket avvisas. Höj inte produktionens gränser för att få provet att gå igenom.
- **Volymen `spool`** ligger på disk, rymmer `MAX_CONCURRENT_UPLOADS` × `MAX_UPLOAD_BYTES`, och ingen annan tjänst läser den.
- **Loggarna:** proxyns logg skriver inte `/api/auth/callback?…` ([Loggar](#loggar)).
- **En äldre Safari (17 eller 18) på en riktig enhet:** kontomenyn, väljaren och dialogerna går att använda med touch och tangentbord, mikrofonen fungerar, en avbruten inspelning kan fortsättas, och en osänd inspelning finns kvar efter utloggning och ny inloggning i samma webbläsarprofil.
- **Ett helt varv:** en livesession, en inspelning, en uppladdning och ett resultat med PDF.

## Uppgradera

Byt `MODULE_VERSION` till den nya taggen (`vX.Y.Z`) och driftsätt om. Fäst alltid en version: med `latest` hämtas ingen ny image om en med det namnet redan finns på värden. Stoppa den gamla containern innan den nya startar. Sessionerna ligger i processens minne, så två containrar samtidigt skickar personer fel, och alla loggar in igen efter bytet. Att gå tillbaka är att byta tillbaka. Efter bytet svarar `/health` med den nya utgåvan.

## Vilken version som körs

`<MODULE_PUBLIC_URL>/health` svarar utan inloggning. Ange `revision` i en felanmälan: den pekar ut koden exakt, också när utgåvan är okänd. En inloggad användare ser samma uppgifter under **Version** sist i flödeslistan, och **Kopiera supportinformation** ger dem som text.

```
curl -fsS https://transkribering.example.org/health
{"ok":true,"revision":"<commit, 40 tecken>","build_date":"2026-01-31T12:00:00Z","release":"v1.2.3"}
```

| Fält | Betydelse | `null` när |
|---|---|---|
| `release` | `MODULE_VERSION`, när värdet är en versionstagg (`vX.Y.Z`). | `MODULE_VERSION` är `latest`, en `sha-<commit>`-tagg, tom eller något annat, eller imagen är byggd lokalt. |
| `revision` | Commiten imagen byggdes från. | Imagen är byggd utan byggargument, som ett lokalt bygge. |
| `build_date` | När imagen byggdes, i UTC. Inte utgåvans eller driftsättningens tid. | Som `revision`. |

Utgåvan kommer från driftsättningen: en utgåva ger en redan testad image sin tagg utan att bygga om den, så `docker-compose.yml` skickar `MODULE_VERSION` till containern. Commiten och byggtiden kommer från imagen och står också som dess etiketter (`org.opencontainers.image.revision`, `.created` och `.source`):

```
docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' ghcr.io/eneo-ai/eneo-mod-speech-to-text:v1.2.3
```

Hur backenden läser värdena: [Backend](backend.md#hälsokontrollen).

## Miljövariabler

Backend läser miljön en gång vid start (`load_settings` i `backend/app/config.py`). Ett ogiltigt värde stoppar starten med ett fel som namnger variabeln. Variabler utan standard måste sättas, och exempelvärdet `sk_replace_me` i `ENEO_API_KEY` godtas inte.

| Variabel | Standard | Regel och betydelse |
|---|---|---|
| `MODULE_VERSION` | `latest` | Imagens tagg i `docker-compose.yml`, som också skickar värdet till containern. En versionstagg (`vX.Y.Z`) blir utgåvan i `/health`; andra värden stoppar aldrig starten. |
| `ENEO_BACKEND_URL` | | Absolut http(s)-URL utan query eller fragment: dit modulen når Eneos API (`http://backend:8000` på Eneos `module_net`). |
| `ENEO_PUBLIC_URL` | | Eneos publika adress, dit webbläsaren skickas för att logga in. `https`; `http` bara för `localhost`, `127.0.0.1` och `[::1]`. |
| `MODULE_PUBLIC_URL` | | Modulens publika adress. Samma regel som `ENEO_PUBLIC_URL`. Ger callback-URL:en och den tillåtna `Origin`. |
| `MODULE_KEY` | `speech-to-text` i Compose | Modulens nyckel i Eneo. Gemener i kebab-case. |
| `ENEO_API_KEY` | | Servicenyckeln (`sk_…`). Hemlig. |
| `ENEO_API_KEY_HEADER_NAME` | `X-API-Key` | Samma som Eneos `API_KEY_HEADER_NAME`. Ett giltigt headernamn som inte är ett som modulen sätter själv (`Authorization`, `Cookie`, `Content-Type` med flera). |
| `SESSION_SECRET` | | Minst 32 tecken, modulens egen: `python -c "import secrets; print(secrets.token_urlsafe(48))"`. Signerar inloggningens state. Hemlig. |
| `COOKIE_SECURE` | `true` | `false` godtas bara när `MODULE_PUBLIC_URL` är `localhost`, `127.0.0.1` eller `[::1]`. |
| `SESSION_MAX_AGE_MINUTES` | `480` | Heltal över 0. Längsta inloggning; Eneos sessionstak (`MODULE_AUTH_MAX_SESSION_HOURS`) gäller om det är kortare. |
| `UPLOAD_PROXY_TIMEOUT_SECONDS` | `1800` | Tid för att skicka en mottagen uppladdning vidare till Eneo. |
| `UPLOAD_RECEIVE_TIMEOUT_SECONDS` | `1800` | Tid för hela mottagningen, inklusive uppehållen mellan delarna i en återupptagbar uppladdning. |
| `UPLOAD_RECEIVE_IDLE_TIMEOUT_SECONDS` | `30` | Längsta väntan utan nya byte från webbläsaren. |
| `UPLOAD_RESUME_IDLE_TIMEOUT_SECONDS` | `300` | Längsta uppehåll mellan anrop till en återupptagbar uppladdning. |
| `MAX_CONCURRENT_UPLOADS` | `1` | Samtidiga uppladdningar. Heltal 1–96, högst `MAX_CONCURRENT_HEAVY_IO`. |
| `MAX_CONCURRENT_HEAVY_IO` | `64` | Gemensamt tak för uppladdningar, filhämtningar och livetext. Heltal 1–96, så att minst fyra av HTTP-poolens 100 anslutningar blir kvar för korta anrop. |
| `MAX_BODY_BYTES` | `10485760` (10 MiB) | Tak för varje request-body utom uppladdningar; 413 över taket. |
| `MAX_UPLOAD_BYTES` | `1073741824` (1 GiB) | Tak för hela request-bodyn i en uppladdning, multipart-överhuvud inräknat. Höj den om flödena tar emot större ljudfiler. |
| `MAX_RESPONSE_BYTES` | `33554432` (32 MiB) | Mest som läses av ett svar från Eneo; längre svar blir 502. En fil som strömmas räknas inte. |
| `ORGANIZATION_*`, `SHOW_ORGANIZATION` | tomma (Eneo), `true` | Namn, logga och accentfärg: [Byt organisation](branding.md). |
| `SPEAKER_REVIEW_ENABLED` | `false` | Byggargument, ingen körningsinställning (`docker build --build-arg SPEAKER_REVIEW_ENABLED=true`). En publicerad image har granskningen av. Att skriva talare kräver stöd för v3 i Eneo. |

De fyra tidsgränserna är sekunder, över 0 och högst 86400. De tre `MAX_*_BYTES` är heltal från 1 till 2^40. Ett tomt värde i Compose blir standardvärdet.

## Vad som står framför modulen

Modulen svarar på vanlig HTTP och läser inga `X-Forwarded-*`-headers. Proxyn framför den ska ge:

- **HTTPS och HSTS.** Proxyn avslutar TLS och sätter `Strict-Transport-Security`; modulen sätter ingen HSTS. Sessionscookien är `Secure` och mikrofonen kräver en säker sida, så hela vägen från webbläsaren till proxyn måste vara HTTPS. Se [HSTS i Traefik](#hsts-i-traefik).
- **Tid för uppladdningar.** Traefik v3.7 har `readTimeout` 60 s, `writeTimeout` 0 (ingen gräns) och `idleTimeout` 180 s per ingångspunkt. `readTimeout` gäller hela requesten med bodyn, så en uppladdning som tar mer än 60 s att skicka kapas. Se [Höj readTimeout i Traefik](#höj-readtimeout-i-traefik).
  - Webbläsaren skickar högst 4 MiB per request, och 60 s räcker då ner till ungefär 0,6 Mbit/s. En klient som använder multipart-rutten direkt skickar hela filen i ett anrop: 1800 s räcker för 1 GiB över 5 Mbit/s.
  - När filen är hos modulen gäller `UPLOAD_PROXY_TIMEOUT_SECONDS` för vägen vidare till Eneo.
  - En eventuell `maxRequestBodyBytes` i proxyn ska rymma `MAX_UPLOAD_BYTES`. Svarar modulen 413 medan webbläsaren fortfarande skickar kan en proxy göra det till ett 502.
- **WebSocket.** Uppgraderingen till `/api/live/...` ska släppas igenom med webbläsarens `Origin` oförändrad. Traefik v3.7 gör det utan extra konfiguration. Går `ENEO_BACKEND_URL` via en proxy ska den också släppa igenom uppgraderingar. Traefiks varning om `aliasHeadersStrategy` vid start är ofarlig för modulen.
- **Rate limiting**, om ni vill ha det. Modulen har ingen egen.

### Höj readTimeout i Traefik

I Dokploy finns ingångspunkterna `web` och `websecure` i Traefiks statiska konfiguration:

1. Öppna `/etc/dokploy/traefik/traefik.yml` på servern, eller **Traefik File System** i Dokploys panel.
2. Lägg `transport` under de `web` och `websecure` som redan finns, och behåll resten av dem (`address`, `http`, certifikat):

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

3. Starta om Traefik, som inte läser om den statiska konfigurationen själv: `docker restart dokploy-traefik`.

En annan Traefik tar samma nycklar i sin `traefik.yml`, eller flaggan `--entryPoints.websecure.transport.respondingTimeouts.readTimeout=1800s`.

### HSTS i Traefik

I Dokploy gäller det här varje tjänst bakom samma Traefik:

1. Skapa `/etc/dokploy/traefik/dynamic/hsts.yml`:

   ```yaml
   http:
     middlewares:
       hsts:
         headers:
           stsSeconds: 31536000
   ```

2. Koppla den till `websecure` i `traefik.yml` och starta om Traefik:

   ```yaml
   entryPoints:
     websecure:
       http:
         middlewares:
           - hsts@file
   ```

Bara för modulen: sätt middleware på modulens router med Compose-etiketterna `traefik.http.middlewares.hsts.headers.stsSeconds=31536000` och `traefik.http.routers.<router>.middlewares=hsts`, där `<router>` är namnet Dokploy gav routern.

## Vad en användare behöver

En aktuell Chrome, Edge, Safari eller Firefox och tillstånd till mikrofonen. Allt visas rätt från Chrome och Edge 125, Safari 26 och Firefox 147; äldre webbläsare öppnar sidan men placerar menyer och väljare fel. Testerna körs i Chromium, WebKit och Firefox ([Tester](quality-gates.md#produktionstesterna)). Mikrofonen kräver HTTPS eller `localhost`.

## Uppladdningens tillfälliga lagring

Modulen tar emot en uppladdning hel innan den skickar den vidare. Containern är skrivskyddad, och `/tmp` är den enda skrivbara platsen: volymen `spool` i `docker-compose.yml`, alltså disk och inte minne. Disken ska rymma `MAX_CONCURRENT_UPLOADS` × `MAX_UPLOAD_BYTES` plus systemets övriga temporärfiler. En full disk ger ett fel på uppladdningen.

- Återupptagbara uppladdningar skrivs direkt till en temporärfil, och multipart-filer större än 1 MB också.
- `UPLOAD_RECEIVE_TIMEOUT_SECONDS` räknas från starten och omfattar avbrotten mellan delarna. En avbruten del skrivs om.
- En övergiven fil städas efter `UPLOAD_RESUME_IDLE_TIMEOUT_SECONDS` utan anrop, eller när totaltiden går ut. Ett anrop förlänger uppehållstiden men aldrig totaltiden.
- En färdig uppladdning lämnar bara en liten kvittens, i högst 30 minuter. Högst 256 finns samtidigt; den äldsta färdiga tas bort när plats behövs, aldrig en aktiv fil.
- Startar processen om försvinner positionerna och kvittenserna. Saknas svaret från Eneo kan Eneo redan ha filen. Appen startar då inget flöde utan kräver ett uttryckligt nytt försök, och en ny uppladdning kan lämna den tidigare filen utan körning.
- Är taket nått svarar modulen 503 med `Retry-After: 2` innan något lagras. Filhämtningar och livetext delar taket; livetexten får ett fel som går att försöka igen, och inspelningen fortsätter lokalt.

Koden: `backend/app/resumable.py`, `backend/app/limits.py` och `backend/app/main.py`.

## Kapacitet för live-texten

Statiska filer, uppladdningar och live-reläet delar en process. Mätt på en bärbar dator ryms en livesession och omkring 45 nya besök i sekunden utan märkbar fördröjning; vid omkring 100 i sekunden är processen mättad. En körare med 4 vCPU i GitHub Actions klarar ungefär hälften, så acceptanskontrollen räknar i andelar av vad maskinen klarar, och "opåverkad" gäller upp till en tredjedel av det. Det är en observation, inget löfte. Mer kapacitet än en process kräver ett delat sessionslager.

## Inget att säkerhetskopiera

Modulen har ingen databas. Sessioner ligger i minnet, inspelningar i användarens webbläsare tills Eneo har tagit emot dem, och flöden, körningar och filer ägs av Eneo. Monteringarna är uppladdningens tillfälliga lagring och en valfri, skrivskyddad mapp med en logga. Säkerhetskopiera Eneo.

## Eneos modul-overlay

I en Eneo-installation ger Eneos Compose-overlay modulen bara nätverket `module_net` och variablerna ovan, med `ENEO_BACKEND_URL` som `http://backend:8000`, och mappar operatörens hemlighet till `ENEO_API_KEY`. Modulen exponerar port 3001 och `/health`.

## Loggar

Modulen loggar till containerns stdout och stderr: `docker compose logs speech-to-text`. Det finns ingen accesslogg. Fel och varningar har tydliga etiketter (upstream-fel, misslyckad ticketväxling, en logga som inte kunde läsas), men ingen token och ingen URL med query. Proxyns logg ska inte heller skriva callbackens query string: den bär en engångsticket.

## CI och utgåvor

`.github/workflows/ci.yml` körs vid pull request och push till `main`. `gate.yml` kör gatens övriga projekt varje natt på `main` ([Tester](quality-gates.md#validera-en-förbättring)). `docs.yml` bygger och kontrollerar `docs-site/` och publicerar ändringar på `main` till [GitHub Pages](https://eneo-ai.github.io/eneo-mod-speech-to-text/).

- **Pages första gången:** en repoadministratör väljer **Settings → Pages → Build and deployment → Source: GitHub Actions**. Arbetsflödets token kan publicera men inte aktivera Pages; steget **Check GitHub Pages configuration** kontrollerar inställningen. Svarar publiceringen `404 Not Found`, kontrollera inställningen och kör jobbet igen, eller **Actions → Docs → Run workflow → main**. På andra grenar bygger och kontrollerar en manuell körning utan att publicera.
- **Imagen:** jobbet `image` i `ci.yml` ger bygget commiten och en tidpunkt. `Dockerfile` skriver dem som imagens etiketter och i byggposten som `/health` svarar med, och imagens acceptans kräver att de stämmer överens.
- **Utgåvan:** `release.yml` körs när en tagg `vX.Y.Z` pushas och bygger ingenting. Den kopierar imagen `sha-<commit>` som CI testade till `vX.Y.Z` och `latest`, kontrollerar att imagens `org.opencontainers.image.revision` är den taggade commiten och skapar en GitHub-utgåva med `docker-compose.yml` och `env.example`. En commit som inte gått igenom CI på `main` har ingen image, och taggen misslyckas: kör jobbet igen när CI är klart. Säger imagen en annan commit skapas ingen utgåva, men taggarna i registret pekar redan på imagen och rättas för hand.

```
git tag v1.2.3 <commit på main>
git push origin v1.2.3
```

## Uppdatera beroenden och fästa versioner

Allt CI och imagen kör är fäst: backendens paket i en låsfil med hashar, basimagerna vid digest, GitHub Actions vid commit-sha och `docs-site/` till exakta versioner. Inget uppdateras av sig självt och repot har ingen Dependabot. Uppdatera till exempel varje månad och när en sårbarhet rapporteras, ett steg i taget, och låt CI och imagens acceptans gå igenom innan nästa. CI stoppar vid fynd i produktionsberoendena (`npm audit` från nivån high, `pip-audit` på låsfilen).

- **Backendens paket:** ändra versionen i `backend/requirements.txt` och generera om låsfilen från repots rot. `backend/tests/test_dependency_lock.py` stoppar en ändring av den ena filen utan den andra.

  ```
  uv pip compile backend/requirements.txt --python-version 3.14 --universal --generate-hashes \
    --exclude-newer <dagens datum>T00:00:00Z -o backend/requirements.lock
  ```

- **Basimagerna** (`Dockerfile`, `deploy/acceptance/compose.yml`, `.github/workflows/`): läs versionens ändringslista, hämta taggens nya digest och byt den där den står.

  ```
  docker buildx imagetools inspect node:24.21.0-bookworm-slim --format '{{.Manifest.Digest}}'
  ```

- **GitHub Actions:** byt commit-sha och versionskommentaren på varje `uses:`. En ny huvudversion är ett eget beslut.

  ```
  git ls-remote --tags https://github.com/actions/checkout 'refs/tags/v7.*'
  ```

- **Dokumentationssajten:** `npm install --save-exact <paket>@<version>` i `docs-site/` och checka in `package.json` och `package-lock.json`. Kontrollera kompatibilitetskraven mellan Astro, Starlight, MD3-temat, OpenAPI-tillägget och Mermaid.

## Vid problem

| Symptom | Trolig orsak och åtgärd |
|---|---|
| Backend startar inte | Felet i loggen namnger variabeln. `Missing required environment variables` räknar upp dem som saknas. `is a placeholder from .env.example`: byt exempelvärdet mot ett eget. En `http`-adress i `MODULE_PUBLIC_URL` eller `ENEO_PUBLIC_URL`, eller `COOKIE_SECURE=false`, godtas bara för `localhost`, `127.0.0.1` och `[::1]`. |
| Backend startar om i en slinga efter en ändrad färg eller logga | Accentfärgen når inte 4,5:1 eller har fel form, eller en logga saknar namn. Loggen säger vad: [Felmeddelanden vid start](branding.md#felmeddelanden-vid-start). |
| Inloggningen misslyckas efter callbacken | Kontrollera den registrerade callback-URL:en tecken för tecken, modulnyckeln och servicenyckeln, och att `ENEO_API_KEY_HEADER_NAME` är samma som Eneos `API_KEY_HEADER_NAME`. Felkoderna: [Inloggning och session](auth-and-session.md#om-callbacken-misslyckas). |
| Tom flödeslista | Användaren är inte medlem i något space med publicerade flöden, eller servicenyckelns omfattning utesluter dem. |
| Mikrofonen går inte att välja | Sidan öppnas inte över HTTPS (eller `localhost`), eller webbläsaren har nekat tillståndet. |
| Uppladdningen faller efter lång tid | Proxyns `readTimeout` (60 s i Traefik v3.7) är kortare än uppladdningen: [Höj readTimeout i Traefik](#höj-readtimeout-i-traefik). |
| Uppladdningen får en felkod | 503 `uploads_busy`: taket är nått, försök igen strax. 408 `upload_receive_timeout`: mottagningen stod stilla eller tog för lång tid. 413 med `max_body_bytes` eller `max_upload_bytes`: höj den variabeln; utan namnet är det Eneos egen gräns. 411: en klient skickade utan `Content-Length`, till exempel en proxy som skickar i delar. 504: vidarebefordran till Eneo tog längre än `UPLOAD_PROXY_TIMEOUT_SECONDS`. 502: `upstream_unreachable` (Eneo nåddes inte; loggen har httpx-felet), `upstream_too_large`, `upstream_redirect` (Eneo omdirigerade, vilket modulen aldrig följer) eller `upstream_invalid` (Eneos svar om en signerad URL gick inte att använda). |
| "Det gick inte att skicka" | Eneo svarade med serverfel på fyra försök att ladda upp samma fil (nätavbrott och 429 räknas inte). Inspelningen ligger kvar i webbläsaren och kan skickas med "Försök igen" ([Inspelaren](recording.md#uppladdning-och-nya-försök)). |
| En gammal färg visas efter ett byte | Färgens stilmall får cachas i fem minuter. Ladda om sidan. |
| "Sidan kunde inte visas." | En flik som stått öppen över en ny version frågar efter filer som inte finns. "Ladda om sidan". |
| Alla blir utloggade | Containern startade om: sessionerna ligger i processens minne. |
