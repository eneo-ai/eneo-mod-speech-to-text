# Kom igång

Du behöver administratörsrätt i Eneo och en server med Docker Compose (Dokploy, Portainer), Podman eller Kubernetes med Helm. Eneos gränssnitt är på engelska, så menynamnen nedan är det också.

## 1. Kontrollera Eneo

- Eneo från `feature/flows-and-builder` eller en senare version. Den har sidan **Admin → Modules** och modulinloggningen (`/module-login`).
- En roll med behörigheterna `admin`, `modules` och `api_keys`. Rollen Owner har dem.
- Ett publicerat flöde med ett ljudsteg som tar emot en fil. Utan det är modulens flödeslista tom.

## 2. Skapa servicenyckeln

Gå till **Administration → API keys** och skapa en nyckel av typen `sk_` med ägaren `service` och behörigheten `write`.

- Ge den så snäv resursomfattning som möjligt, ofta ett eget space.
- Sätt utgångsdatum och rate limit.
- Kopiera hemligheten direkt. Den visas en gång och blir `ENEO_API_KEY`.

## 3. Installera modulen i Eneo

Gå till **Admin → Modules**, fyll i tre värden och välj **Install module**:

| Fält | Värde |
|---|---|
| Modulnyckel | `speech-to-text` |
| Callback-URL | `https://transkribering.example.org/api/auth/callback` (modulens adress följd av `/api/auth/callback`) |
| Servicenyckel | Nyckeln från steg 2 |

- Callback-URL:en ska stämma exakt: HTTPS, inga jokertecken, och samma värd, port, sökväg och avslutande snedstreck. En adress per rad; registrera produktion och test var för sig.
- Modulnyckeln kan inte ändras efteråt, och Eneo skiljer på versaler och gemener.

## 4. Kör modulen

Hämta `docker-compose.yml` och `env.example` från [senaste utgåvan](https://github.com/eneo-ai/eneo-mod-speech-to-text/releases). Spara `env.example` som `.env` och fyll i (med Helm går samma värden i `values.yaml`):

```sh
MODULE_VERSION=v1.2.3
ENEO_BACKEND_URL=https://eneo.example.org
ENEO_PUBLIC_URL=https://eneo.example.org
MODULE_PUBLIC_URL=https://transkribering.example.org
ENEO_API_KEY=sk_...
SESSION_SECRET=...
```

- `MODULE_VERSION` är utgåvans tagg och står redan i `env.example`. Fäst en version i stället för `latest`.
- `ENEO_BACKEND_URL` är dit modulen når Eneos API. På Eneos nätverk `module_net` är den `http://backend:8000`.
- `SESSION_SECRET` ska vara modulens egen, inte en hemlighet som används någon annanstans. Skapa den så här:

  ```sh
  python -c "import secrets; print(secrets.token_urlsafe(48))"
  ```

Driftsätt sedan med [Docker Compose, Dokploy eller Portainer](operations.md#driftsätt-med-dokploy-eller-portainer), [Podman](operations.md#driftsätt-med-podman) eller [Kubernetes och Helm](operations.md#driftsätt-med-kubernetes-och-helm). Modulen lyssnar på port 3001.

> [!WARNING]
> Står Traefik framför modulen, som i Dokploy, kapar den uppladdningar som tar mer än 60 s. [Höj `readTimeout`](operations.md#höj-readtimeout-i-traefik) innan någon laddar upp. En ingress i Kubernetes har motsvarande gränser: [Krav på ingressen](operations.md#krav-på-ingressen).

## 5. Kontrollera

```sh
curl -fsS https://transkribering.example.org/health
```

Svaret ska börja med `{"ok":true` och sluta med den utgåva du satte, till exempel `"release":"v1.2.3"}`. Öppna sedan modulens adress i ett privat fönster: inloggningen ska gå via Eneo och tillbaka till flödeslistan.

Fungerar det inte, se [Vid problem](operations.md#vid-problem). Inför verklig användning: [acceptansen](operations.md#acceptans-innan-verklig-användning).

## 6. Lägg in er logga och färg

Namn, logga och accentfärg är variabler på tjänsten. Sätt dem och starta om; imagen byggs inte om. [Byt organisation](branding.md) har ett färdigt exempel.
