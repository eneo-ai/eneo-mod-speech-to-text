# Byt organisation

En annan kommun eller myndighet kan använda modulen som sin egen utan att ändra kod och utan att bygga om
imagen. Namn, logga och färg är inställningar på tjänsten: ändra dem och starta om den.
Backend skriver organisationen in i sidan när den startar, så märket finns med i första bildrutan.

Utan inställningar visar modulen Eneo, med Eneos logga och Eneos blå (`#1563BC`, i mörkt läge `#52B1FF`).

## Inställningar

Alla sätts som miljövariabler på tjänsten `speech-to-text` (`docker-compose.yml` för dem vidare från din
`.env`).

| Variabel | Standard | Vad den gör |
| --- | --- | --- |
| `ORGANIZATION_NAME` | Eneo | Organisationens namn i sidhuvudet. Högst 100 tecken. Är också loggans alternativtext. Ett eget namn visas också under inloggningen: "Sundsvalls kommun använder Eneo." |
| `ORGANIZATION_LOGO` | Eneos logga | Sökväg i modulens container till en SVG- eller PNG-fil, till exempel `/branding/logo.svg`. Kräver `ORGANIZATION_NAME`. |
| `ORGANIZATION_LOGO_DARK` | (ingen) | Valfri logga för mörkt läge. Utan den visas `ORGANIZATION_LOGO` i båda lägena. |
| `SHOW_ORGANIZATION` | `true` | `false` visar bara "Tal till text", ingen organisation. Accentfärgen gäller ändå. |
| `ORGANIZATION_ACCENT` | `#1563BC` | Accentfärgen som `#RRGGBB`: knappar, länkar, fokusramar, valda val, ikoner och nivåmätaren. |
| `ORGANIZATION_ACCENT_DARK` | härleds | Accentfärgen i mörkt läge, som `#RRGGBB`. Utelämnad härleds den ur den ljusa. |

Ett namn utan logga visas som text. Från 640 px bredd står det på högst två rader: ett namn på upp till ungefär 80
tecken får plats, ett längre kortas med …. På en telefon står namnet på en rad, och bara om det ryms bredvid "Tal till
text". Annars visas varken namnet eller strecket bredvid det, och sidhuvudet visar bara "Tal till text". Sidan mäter
det i webbläsaren: på en telefon som är 390 px bred ryms ungefär 30 tecken, på den smalaste (320 px) ungefär 20, till
exempel "Sundsvalls kommun". Detsamma gäller loggan när läsaren har mycket stor text eller zoomar en telefon till
200 %: ryms den inte bredvid "Tal till text" visas den inte. Hela namnet står alltid i länkens namn ("Tal till text – Umeå kommun") och under
inloggningen. En organisation kan alltså byta enbart namn, enbart färg eller allt.

## Loggan

- **Format:** SVG eller PNG, högst 1 MiB. Filens ändelse och innehåll måste stämma med varandra. En fil som saknas
  eller inte duger loggas en gång vid start (se Varningar vid start), och namnet visas som text i stället för loggan.
- **Storleken måste gå att läsa:** en SVG behöver en `viewBox`, eller både `width` och `height` i px. En PNG har den i
  sitt huvud. Backend läser den vid start och sidan reserverar loggans plats med den, så att sidhuvudet inte flyttar sig
  när filen kommer. En logga utan läsbar storlek räknas som en logga som inte duger.
- **Storlek:** loggan visas 40 px hög, och ett nästan kvadratiskt märke (smalare än 3:2) 32 px, så att det inte väger
  tyngre än produktnamnet bredvid. En bred logga krymper så att den ryms i 104 px (telefon) eller 160 px (dator) bredd.
  Bäst är därför ett liggande märke på ungefär 4:1 eller smalare, till exempel 160 × 40 px. En logga som är 10:1 syns på
  en telefon bara som ett smalt streck, och backend varnar vid start för en logga som är bredare än 6:1.
- **Ljust och mörkt:** sidans bakgrund är nästan vit i ljust läge och nästan svart i mörkt. Är loggan svart eller
  mörk, ge den en ljus variant som `ORGANIZATION_LOGO_DARK`. Utan den står loggan på en vit platta i mörkt läge, så att
  den syns, men en egen ljus variant ser bättre ut.
- **Alternativtext:** `ORGANIZATION_NAME` är loggans alternativtext och länkens namn ("Tal till text – Umeå
  kommun"). Skriv organisationens fullständiga namn, inte "logotyp".
- Backend serverar loggan från samma origin (`/api/branding/logo/light` och `/dark`), eftersom sidans säkerhetspolicy
  bara tillåter egna bilder. En SVG körs aldrig som skript: den visas bara som bild.

## Accentfärgen

`ORGANIZATION_ACCENT` ersätter modulens blå överallt där den förekommer, i ljust och mörkt läge. Accenten är också textfärgen på länkar och ikoner och färgen på fokusramen, så den måste vara läsbar mot sidan: backend kontrollerar vid start att den når minst **4,5:1** i WCAG-kontrast mot sidans ytor i båda lägena (och att texten på accenten och den sekundära texten på dess ton gör det), och en färg som inte gör det stoppar starten. Det betyder en mörk färg i ljust läge och en ljus i mörkt.

**De gråa färgerna följer med.** Sidans gråa ytor, textfärger, kanter och skuggor har en ton av Eneos blå. Med
`ORGANIZATION_ACCENT` får de accentens ton i stället, med samma ljushet: en grön accent ger grönaktigt gråa ytor, och
inget på sidan blir kvar i Eneos blå. Backend ser till att den sekundära texten når 4,5:1 och en kontrolls kant 3:1 mot
varje yta, även i den nya tonen. En grå accent ger rent gråa ytor. I mörkt läge tonas ytorna svagare ju längre accentens
nyans ligger från Eneos blå, så att en röd eller grön accent inte ger bruna eller olivgröna ytor.

**Talarnas färger.** Varje talare i transkriberingen har en egen färg, och ingen av dem är accentens, så att ett namn inte
ser ut som en länk. Ligger en talares färg nära accentens nyans (närmare än 30 grader) får talaren en reservfärg i
stället, magenta eller gulgrön. Har ljust och mörkt läge var sin nyans kan reservfärgerna ta slut: då behåller talaren sin
ljushet i den nyans som ligger längst från accenterna och de andra talarna, aldrig blå. Backend ser till att varje talares färg når 4,5:1 mot sidans ytor och mot tonen på en
markerad rad och på stycket som spelas, även i accentens ton.

**Transkriberingen när den spelas.** Stycket som spelas, dess mening, orden som har sagts och ordet som sägs får var sin
ton av accentfärgen, lagda på varandra. Med en mycket ljus färg i mörkt läge, eller en mycket mörk i ljust läge, skulle
texten på dem hamna under 4,5:1. Då gör backend alla tonerna lika mycket svagare, så att texten når 4,5:1. Det gäller
också modulens egen blå i mörkt läge, med eller utan `ORGANIZATION_ACCENT`.

**Mörkt läge.** Utelämnar du `ORGANIZATION_ACCENT_DARK` gör backend färgen ljusare tills kraven nås och behåller nyans och mättnad. Vill du styra det själv anger du en egen färg, som kontrolleras på samma sätt.

**Exempel som godkänns:** `#1C7531` (grön), `#1563BC` och `#004595` (blå), `#6B1EFD` (violett), `#00695C` (blågrön).
Undvik en röd accent: den ligger nära felfärgen, så att knappar och länkar kan läsas som fel. Du kan pröva en färg utan att
starta tjänsten, från mappen `backend`:

```sh
.venv/bin/python -c "from app.accent import resolve_accent; print(resolve_accent('#1C7531', None))"
```

### Felmeddelanden vid start

Ett fel stoppar backend, som startar om tills det är rättat. Läs meddelandet med `docker compose logs
speech-to-text`. Det är alltid ett enda meddelande som anger vad som mättes och det lägsta tillåtna.

| Meddelande | Orsak och åtgärd |
| --- | --- |
| `ORGANIZATION_ACCENT=#FFD700: accentfärgen mot sidans ytor når 1,30:1 i ljust läge men måste nå minst 4,50:1. Välj en mörkare färg.` | Färgen är för ljus för att läsas mot sidan. Välj en mörkare. |
| `ORGANIZATION_ACCENT_DARK=#1C7531: accentfärgen mot sidans ytor når 2,74:1 i mörkt läge men måste nå minst 4,50:1. Välj en ljusare färg.` | Den mörka färgen är för mörk mot mörk bakgrund. Välj en ljusare eller utelämna variabeln. |
| `ORGANIZATION_ACCENT måste vara en färg på formen #RRGGBB, till exempel #1C7531 (fick 'grön')` | Färgen ska vara `#` följt av sex hexadecimala siffror. Namn som `green` och korta former som `#1b3` godtas inte. |
| `ORGANIZATION_LOGO kräver ORGANIZATION_NAME: namnet är loggans alternativtext.` | En logga utan namn. Sätt `ORGANIZATION_NAME`. |

### Varningar vid start

En varning stoppar inte backend. Den står en gång i loggen, och sidan visar det som går.

| Meddelande | Orsak och åtgärd |
| --- | --- |
| `ORGANIZATION_LOGO=/branding/logo.svg kan inte läsas (filen saknas). Namnet visas i stället. Kontrollera sökvägen och volymen.` | Filen finns inte i containern. Kontrollera sökvägen och att mappen är monterad. |
| `ORGANIZATION_LOGO=/branding/logo.gif är ingen SVG- eller PNG-fil (till namn och innehåll). Namnet visas i stället.` | Använd en SVG- eller PNG-fil vars ändelse stämmer med innehållet. Samma form gäller en fil som är större än 1 MiB eller saknar storlek. |
| `ORGANIZATION_LOGO är 10:1; på en telefon blir den 10 px hög. Använd ett märke på högst 4:1.` | Loggan är så bred att den blir ett smalt streck på en telefon. Använd ett märke på högst 4:1. |
| `ORGANIZATION_ACCENT=#B3261E: accentfärgen ligger nära felfärgen i ljust läge (#B3261E), så knappar och länkar kan läsas som fel. Välj en färg längre från rött.` | Färgen godkänns men liknar felfärgen. Välj en färg med en annan nyans. |

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
ORGANIZATION_ACCENT=#1C7531
# ORGANIZATION_ACCENT_DARK=#269E42   # utelämnad härleds den
```

Starta om: `docker compose up -d`. Ändrar du bara en fil som redan är monterad räcker `docker compose restart
speech-to-text`, eftersom loggorna läses vid start.

Webbläsare och mellanlager får behålla accentfärgens stilmall i fem minuter (`Cache-Control: max-age=300`) och
frågar sedan om den ändrats. Efter ett byte kan en gammal flik alltså visa den gamla färgen en kort stund. Ladda
om sidan, eller öppna den i ett privat fönster.

## Behåll Sundsvalls kommun

Sundsvalls logga följer med i imagen (`/app/web/brand/`), i en svart och en vit variant, så ingen volym behövs.
Sätt variablerna på tjänsten och starta om den:

```sh
ORGANIZATION_NAME=Sundsvalls kommun
ORGANIZATION_LOGO=/app/web/brand/sundsvalls-kommun-logotyp.svg
ORGANIZATION_LOGO_DARK=/app/web/brand/sundsvalls-kommun-logotyp-vit.svg
ORGANIZATION_ACCENT=#004595
ORGANIZATION_ACCENT_DARK=#52B1FF
```

Kontrollera efter omstarten att `curl -s https://din-modul.example/api/branding` svarar med `"logo":"custom"` och
`"dark_logo":true`.

## Så kontrollerar du

1. **Öppna sidan** i ljust och mörkt läge (kontomenyn, "Tema"). Inloggningssidan, flödeslistan, en flödessida och
   en inspelning ska ha organisationens logga och färg, och ingenting i modulens blå.
2. **Titta på stilmallen:** `curl -i https://din-modul.example/api/branding/theme.css`. Utan
   `ORGANIZATION_ACCENT` sätter den bara tonen i transkriberingen (`--module-accent-tint`). Med den innehåller den din
   färg, och färgen i mörkt läge efter `light-dark(`.

## Vad som inte kan ändras utan kod

Följande är modulens, inte organisationens, och ändras i koden:

- All text i gränssnittet. Den är svenska och finns i komponenterna. Produktnamnet "Tal till text" också.
- Layout, avstånd, rundning, teckensnitt (Figtree, Eneos, som följer med modulen) och storlekar. Modulen laddar inga
  typsnitt eller skript från andra adresser.
- Statusfärgerna (till exempel rött för fel och grönt för klart) och talarnas färger i transkriberingen. Av färgerna
  är bara accenten organisationens; de gråa ytorna tar dess ton (se Accentfärgen).
- Den medföljande loggan, Eneos ordmärke i en ljus och en mörk variant (`frontend/public/brand/`), som är det som
  visas utan `ORGANIZATION_LOGO`.
- Ikonen i fliken och på hemskärmen: Eneos märke, `frontend/public/favicon.svg`. `apple-touch-icon.png` är
  samma märke, vitt på Eneos blå, i 180 × 180 px, utan rundade hörn eftersom telefonen rundar dem själv; ändras märket görs bilden om.
  Organisationens logga är för bred för en ikon.
- Färgen på webbläsarens egen list ovanför sidan (`theme-color` i `frontend/index.html`): sidans ytfärg, efter
  systemets ljusa eller mörka läge. Ett läge som väljs under "Tema" i kontomenyn ändrar den inte.
- Sidans titel och fliknamn, "Tal till text".
