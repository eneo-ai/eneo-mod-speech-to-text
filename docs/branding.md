# Byt organisation

En annan kommun eller myndighet kan använda modulen som sin egen utan att ändra kod och utan att bygga om
imagen. Namn, logga och färg är inställningar på tjänsten: ändra dem och starta om den.
Backend skriver organisationen in i sidan när den startar, så märket finns med i första bildrutan.

Utan inställningar visar modulen Sundsvalls kommun och modulens standardblå (`#004595`).

## Inställningar

Alla sätts som miljövariabler på tjänsten `speech-to-text` (`docker-compose.yml` för dem vidare från din
`.env`).

| Variabel | Standard | Vad den gör |
| --- | --- | --- |
| `ORGANIZATION_NAME` | Sundsvalls kommun | Organisationens namn i sidhuvudet. Högst 100 tecken. Är också loggans alternativtext. |
| `ORGANIZATION_LOGO` | modulens egen logga | Sökväg i backend-containern till en SVG- eller PNG-fil, till exempel `/branding/logo.svg`. Kräver `ORGANIZATION_NAME`. |
| `ORGANIZATION_LOGO_DARK` | (ingen) | Valfri logga för mörkt läge. Utan den visas `ORGANIZATION_LOGO` i båda lägena. |
| `SHOW_ORGANIZATION` | `true` | `false` visar bara "Tal till text", ingen organisation. Accentfärgen gäller ändå. |
| `ORGANIZATION_ACCENT` | `#004595` | Accentfärgen som `#RRGGBB`: knappar, länkar, fokusramar, valda val, ikoner och nivåmätaren. |
| `ORGANIZATION_ACCENT_DARK` | härleds | Accentfärgen i mörkt läge, som `#RRGGBB`. Utelämnad härleds den ur den ljusa. |

Ett namn utan logga visas som text. En organisation kan alltså byta enbart namn, enbart färg eller allt.

## Loggan

- **Format:** SVG eller PNG, högst 1 MiB. Filens ändelse och innehåll måste stämma med varandra. En fil som saknas
  eller inte duger loggas en gång vid start, och namnet visas som text i stället för loggan.
- **Storleken måste gå att läsa:** en SVG behöver en `viewBox`, eller både `width` och `height` i px. En PNG har den i
  sitt huvud. Backend läser den vid start och sidan reserverar loggans plats med den, så att sidhuvudet inte flyttar sig
  när filen kommer. En logga utan läsbar storlek räknas som en logga som inte duger.
- **Storlek:** loggan visas 40 px hög. En bred logga krymper så att den ryms i 104 px (telefon) eller 160 px (dator)
  bredd. Bäst är därför ett liggande märke på ungefär 4:1 eller smalare, till exempel 160 × 40 px. En logga som är
  10:1 syns på en telefon bara som ett smalt streck.
- **Ljust och mörkt:** sidans bakgrund är nästan vit i ljust läge och nästan svart i mörkt. Är loggan svart eller
  mörk, ge den en ljus variant som `ORGANIZATION_LOGO_DARK`. Har loggan en genomskinlig bakgrund och färger som syns
  mot båda, räcker en fil.
- **Alternativtext:** `ORGANIZATION_NAME` är loggans alternativtext och länkens namn ("Tal till text – Umeå
  kommun"). Skriv organisationens fullständiga namn, inte "logotyp".
- Backend serverar loggan från samma origin (`/api/branding/logo/light` och `/dark`), eftersom sidans säkerhetspolicy
  bara tillåter egna bilder. En SVG körs aldrig som skript: den visas bara som bild.

## Accentfärgen

`ORGANIZATION_ACCENT` ersätter modulens blå överallt där den förekommer, i ljust och mörkt läge. Accenten är också textfärgen på länkar och ikoner och färgen på fokusramen, så den måste vara läsbar mot sidan: backend kontrollerar vid start att den når minst **4,5:1** i WCAG-kontrast mot sidans ytor i båda lägena (och att texten på accenten och den sekundära texten på dess ton gör det), och en färg som inte gör det stoppar starten. Det betyder en mörk färg i ljust läge och en ljus i mörkt.

**Mörkt läge.** Utelämnar du `ORGANIZATION_ACCENT_DARK` gör backend färgen ljusare tills kraven nås och behåller nyans och mättnad. Vill du styra det själv anger du en egen färg, som kontrolleras på samma sätt.

**Exempel som godkänns:** `#1E7B34` (grön), `#004595` (blå), `#B3261E` (röd), `#6B1EFD` (violett), `#00695C` (blågrön). Du kan pröva en färg utan att starta tjänsten, från mappen `backend`:

```sh
.venv/bin/python -c "from app.accent import resolve_accent; print(resolve_accent('#1E7B34', None))"
```

### Felmeddelanden vid start

Ett fel stoppar backend, som startar om tills det är rättat. Läs meddelandet med `docker compose logs
speech-to-text`. Det är alltid ett enda meddelande som anger vad som mättes och det lägsta tillåtna.

| Meddelande | Orsak och åtgärd |
| --- | --- |
| `ORGANIZATION_ACCENT=#FFD700: accentfärgen mot sidans ytor når 1,23:1 i ljust läge men måste nå minst 4,50:1. Välj en mörkare färg.` | Färgen är för ljus för att läsas mot sidan. Välj en mörkare. |
| `ORGANIZATION_ACCENT_DARK=#1E7B34: accentfärgen mot sidans ytor når 2,45:1 i mörkt läge men måste nå minst 4,50:1. Välj en ljusare färg.` | Den mörka färgen är för mörk mot mörk bakgrund. Välj en ljusare eller utelämna variabeln. |
| `ORGANIZATION_ACCENT måste vara en färg på formen #RRGGBB, till exempel #1E7B34 (fick 'grön')` | Färgen ska vara `#` följt av sex hexadecimala siffror. Namn som `green` och korta former som `#1b3` godtas inte. |

## Exempel med docker compose

Lägg filerna i en mapp bredvid `docker-compose.yml` och montera den skrivskyddat i tjänsten. Dokploy och Portainer
läser bara `docker-compose.yml` (inte `docker-compose.override.yml`), så raden hör hemma där, bland tjänstens
`volumes` bredvid uppladdningarnas `spool` (en utkommenterad rad står redan där):

```yaml
services:
  speech-to-text:
    volumes:
      - spool:/tmp
      - ./branding:/branding:ro
```

Sätt värdena i `.env`:

```sh
ORGANIZATION_NAME=Umeå kommun
ORGANIZATION_LOGO=/branding/logo.svg
ORGANIZATION_LOGO_DARK=/branding/logo-mork.svg
ORGANIZATION_ACCENT=#1E7B34
# ORGANIZATION_ACCENT_DARK=#2AAE4A   # utelämnad härleds den
```

Starta om: `docker compose up -d`. Ändrar du bara en fil som redan är monterad räcker `docker compose restart
speech-to-text`, eftersom loggorna läses vid start.

Webbläsare och mellanlager får behålla accentfärgens stilmall i fem minuter (`Cache-Control: max-age=300`) och
frågar sedan om den ändrats. Efter ett byte kan en gammal flik alltså visa den gamla färgen en kort stund. Ladda
om sidan, eller öppna den i ett privat fönster.

## Så kontrollerar du

1. **Öppna sidan** i ljust och mörkt läge (kontomenyn, "Tema"). Inloggningssidan, flödeslistan, en flödessida och
   en inspelning ska ha organisationens logga och färg, och ingenting i modulens blå.
2. **Titta på stilmallen:** `curl -i https://din-modul.example/api/branding/theme.css`. Utan
   `ORGANIZATION_ACCENT` är den en enda kommentar. Med den innehåller den din färg, och färgen i mörkt läge efter
   `light-dark(`.

## Vad som inte kan ändras utan kod

Följande är modulens, inte organisationens, och ändras i koden:

- All text i gränssnittet. Den är svenska och finns i komponenterna. Produktnamnet "Tal till text" också.
- Layout, avstånd, rundning, teckensnitt (systemets) och storlekar. Modulen laddar inga typsnitt eller skript från
  andra adresser.
- De neutrala gråa ytorna och textfärgerna, statusfärgerna (till exempel rött för fel och grönt för klart) och
  talarnas färger i transkriptet. Bara accentfärgen är organisationens.
- Den medföljande loggan (`frontend/public/brand/`), som är det som visas utan `ORGANIZATION_LOGO`.
- Sidans titel och fliknamn, "Tal till text".
