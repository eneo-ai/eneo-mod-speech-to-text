# Byt organisation

## Kort version

Namn, logga och accentfärg är miljövariabler på tjänsten `speech-to-text`. Sundsvalls kommuns loggor följer med i imagen:

```sh
ORGANIZATION_NAME=Sundsvalls kommun
ORGANIZATION_LOGO=/app/web/brand/sundsvalls-kommun-logotyp.svg
ORGANIZATION_LOGO_DARK=/app/web/brand/sundsvalls-kommun-logotyp-vit.svg
ORGANIZATION_ACCENT=#004595
ORGANIZATION_ACCENT_DARK=#52B1FF
```

En annan organisation lägger sina loggor i en mapp på servern och monterar den skrivskyddat i tjänsten, i `docker-compose.yml` (Dokploy och Portainer läser bara den filen). Raden står redan där, utkommenterad. En absolut sökväg på servern är enklast i Dokploy och Portainer:

```yaml
services:
  speech-to-text:
    volumes:
      - spool:/tmp
      - /srv/tal-till-text/branding:/branding:ro
```

```sh
ORGANIZATION_NAME=Umeå kommun
ORGANIZATION_LOGO=/branding/logo.svg
ORGANIZATION_LOGO_DARK=/branding/logo-mork.svg
ORGANIZATION_ACCENT=#1C7531
```

Starta sedan om tjänsten: driftsätt om i Dokploy eller Portainer, eller kör `docker compose up -d`. Imagen byggs inte om. Byter du bara en fil i en mapp som redan är monterad räcker `docker compose restart speech-to-text`, eftersom loggorna läses vid start.

### Loggan

- SVG eller PNG, högst 1 MiB, och filens ändelse stämmer med innehållet.
- En SVG har en `viewBox`, eller både `width` och `height` i px.
- Liggande, helst ungefär 4:1, till exempel 160 × 40 px. Bredare än 6:1 blir ett smalt streck på en telefon.
- Är loggan mörk, ge en ljus variant i `ORGANIZATION_LOGO_DARK`. Annars står den på en vit platta i mörkt läge.

### Färgen

`ORGANIZATION_ACCENT` ersätter modulens blå på knappar, länkar, fokusramar, valda val, ikoner och nivåmätaren. Färgen måste nå WCAG-kontrasten 4,5:1 mot sidans ytor. Gör den inte det startar modulen inte, och loggen säger vad som mättes och om färgen ska vara ljusare eller mörkare. I praktiken är det en mörk färg i ljust läge. Utan `ORGANIZATION_ACCENT_DARK` tar modulen fram en ljusare variant för mörkt läge själv. Grå ytor, markeringar och talarnas färger anpassas efter accenten så att texten förblir läsbar.

### Så kontrollerar du

1. **Loggen:** `docker compose logs speech-to-text` har inget fel och ingen varning som börjar med `ORGANIZATION_`.
2. **Loggan:** `curl -s https://din-modul.example/api/branding` svarar med `"logo":"custom"`, och med en mörk logga även `"dark_logo":true`.
3. **Sidan:** öppna den i ljust och mörkt läge (kontomenyn, **Tema**). Inloggningen, flödeslistan, en flödessida och en inspelning har er logga och färg och ingenting i modulens blå.

En gammal flik kan visa den gamla färgen i upp till fem minuter. Ladda om sidan.

## Detaljer

### Alla inställningar

| Variabel | Standard | Vad den gör |
| --- | --- | --- |
| `ORGANIZATION_NAME` | Eneo | Namnet i sidhuvudet, högst 100 tecken. Är också loggans alternativtext, så skriv hela namnet, inte "logotyp". Ett eget namn visas också under inloggningen: "Sundsvalls kommun använder Eneo." |
| `ORGANIZATION_LOGO` | Eneos logga | Sökväg i containern till en SVG- eller PNG-fil. Kräver `ORGANIZATION_NAME`. |
| `ORGANIZATION_LOGO_DARK` | (ingen) | Logga för mörkt läge. Utan den visas `ORGANIZATION_LOGO` i båda lägena. |
| `SHOW_ORGANIZATION` | `true` | `false` visar bara "Tal till text". Accentfärgen gäller ändå. |
| `ORGANIZATION_ACCENT` | `#1563BC` (Eneos blå) | Accentfärgen som `#RRGGBB`. |
| `ORGANIZATION_ACCENT_DARK` | härleds | Accentfärgen i mörkt läge som `#RRGGBB`. Kräver `ORGANIZATION_ACCENT`. Utan någon accent är den `#52B1FF`. |

Variablerna är oberoende: en organisation kan byta bara namnet, bara färgen eller allt. Ett namn utan logga visas som text.

### Sidhuvudet

- **Loggan** visas 40 px hög, och ett nästan kvadratiskt märke (smalare än 3:2) 32 px, så att den inte väger tyngre än "Tal till text". En bred logga krymper för att rymmas i 104 px bredd på en telefon och 160 px från 640 px skärmbredd.
- **Ett namn utan logga** står från 640 px bredd på högst två rader: upp till ungefär 80 tecken får plats, ett längre kortas med …. På en telefon står det på en rad, och bara om det ryms bredvid "Tal till text": ungefär 30 tecken på en 390 px bred telefon och 20 på en 320 px bred.
- **Får namnet eller loggan inte plats**, till exempel med mycket stor text eller 200 % zoom på en telefon, visar sidhuvudet bara "Tal till text". Hela namnet står alltid i länkens namn ("Tal till text – Umeå kommun") och under inloggningen.
- **Loggans storlek** läses vid start, och sidan reserverar platsen med den så att sidhuvudet inte flyttar sig. Backend serverar loggan från modulens egen adress (`/api/branding/logo/light` och `/dark`), och en SVG visas bara som bild, aldrig som skript.

### Accentfärgen

Backend prövar färgen vid start mot tre krav i varje läge, 4,5:1 vardera: texten på accentfärgen, accentfärgen mot sidans ytor och den sekundära texten på accentens ton på valda rader.

- **De gråa färgerna** har en ton av Eneos blå. Med `ORGANIZATION_ACCENT` får ytor, text, kanter och skuggor accentens ton i samma ljushet, så att inget blir kvar i Eneos blå. Sekundär text behåller 4,5:1 och en kontrolls kant 3:1 mot varje yta. En grå accent ger rent gråa ytor. I mörkt läge tonas ytorna svagare ju längre accenten ligger från Eneos blå, så att en röd eller grön accent inte ger bruna eller olivgröna ytor.
- **Talarnas färger** är aldrig accentens, så att ett namn inte ser ut som en länk. En talare vars färg ligger närmare än 30 grader från accentens nyans får en reservfärg, magenta eller gulgrön. Tar reservfärgerna slut får talaren sin ljushet i den nyans som ligger längst från accenterna och de andra talarna, aldrig blå. Varje talarfärg når 4,5:1 mot sidans ytor, mot en markerad rad och mot stycket som spelas.
- **Transkriberingen som spelas** får toner av accenten för stycket, meningen, de sagda orden och ordet som sägs. Skulle texten på dem hamna under 4,5:1 gör backend alla tonerna lika mycket svagare. Det gäller också modulens egen blå i mörkt läge.
- **Mörkt läge:** utan `ORGANIZATION_ACCENT_DARK` gör backend den ljusa färgen ljusare, med samma nyans och mättnad, tills kraven nås. En egen mörk färg prövas på samma sätt.

Färger som godkänns: `#1C7531` (grön), `#1563BC` och `#004595` (blå), `#6B1EFD` (violett) och `#00695C` (blågrön). Undvik rött: det ligger nära felfärgen, så att knappar och länkar kan läsas som fel. Pröva en färg utan att starta tjänsten, från mappen `backend`:

```sh
.venv/bin/python -c "from app.accent import resolve_accent; print(resolve_accent('#1C7531', None))"
```

Färgens stilmall, `/api/branding/theme.css`, får cachas i fem minuter (`Cache-Control: public, max-age=300`). Utan `ORGANIZATION_ACCENT` sätter den bara transkriberingens ton (`--module-accent-tint`); med den innehåller den din färg och, efter `light-dark(`, färgen i mörkt läge.

### Felmeddelanden vid start

Ett fel stoppar backend, som startar om tills felet är rättat. Meddelandet står i `docker compose logs speech-to-text` och säger vad som mättes och vad som krävs.

| Meddelande | Åtgärd |
| --- | --- |
| `ORGANIZATION_ACCENT=#FFD700: accentfärgen mot sidans ytor når 1,30:1 i ljust läge men måste nå minst 4,50:1. Välj en mörkare färg.` | Välj en mörkare färg. Samma form gäller "texten på accentfärgen" och "den sekundära texten på accentfärgens ton (valda rader)". |
| `ORGANIZATION_ACCENT_DARK=#1C7531: accentfärgen mot sidans ytor når 2,74:1 i mörkt läge men måste nå minst 4,50:1. Välj en ljusare färg.` | Välj en ljusare färg, eller utelämna variabeln. |
| `ORGANIZATION_ACCENT=…: ingen mörk variant av färgen går att härleda som når kraven i mörkt läge. Ange ORGANIZATION_ACCENT_DARK.` | Ange en egen mörk färg. |
| `ORGANIZATION_ACCENT måste vara en färg på formen #RRGGBB, till exempel #1C7531 (fick 'grön')` | `#` och sex hexadecimala siffror. Namn som `green` och korta former som `#1b3` godtas inte. |
| `ORGANIZATION_ACCENT_DARK kräver ORGANIZATION_ACCENT: den mörka färgen hör till en ljus.` | Sätt `ORGANIZATION_ACCENT` också. |
| `ORGANIZATION_LOGO kräver ORGANIZATION_NAME: namnet är loggans alternativtext.` | Sätt `ORGANIZATION_NAME`. Gäller också `ORGANIZATION_LOGO_DARK`. |
| `ORGANIZATION_NAME must be at most 100 characters` | Korta namnet. |

### Varningar vid start

En varning stoppar inte backend. Den står en gång i loggen, och sidan visar det som går: en logga som inte kan användas ersätts av namnet som text.

| Meddelande | Åtgärd |
| --- | --- |
| `ORGANIZATION_LOGO=/branding/logo.svg kan inte läsas (filen saknas). Namnet visas i stället. Kontrollera sökvägen och volymen.` | Kontrollera sökvägen och att mappen är monterad. |
| `ORGANIZATION_LOGO=/branding/logo.gif är ingen SVG- eller PNG-fil (till namn och innehåll). Namnet visas i stället.` | Använd en SVG- eller PNG-fil med rätt ändelse. Samma form säger "är större än 1 MiB" och "har ingen storlek som sidan kan använda". |
| `ORGANIZATION_LOGO är 10:1; på en telefon blir den 10 px hög. Använd ett märke på högst 4:1.` | Använd ett smalare märke. |
| `ORGANIZATION_ACCENT=#B3261E: accentfärgen ligger nära felfärgen i ljust läge (#B3261E), så knappar och länkar kan läsas som fel. Välj en färg längre från rött.` | Färgen godkänns men liknar felfärgen. Välj en annan nyans. |

## Vad som inte kan ändras utan kod

- All text i gränssnittet, på svenska, och produktnamnet "Tal till text", som också är sidans titel.
- Layout, avstånd, rundning, storlekar och teckensnittet Figtree, som följer med modulen. Modulen laddar inga typsnitt eller skript från andra adresser.
- Statusfärgerna, till exempel rött för fel och grönt för klart, och talarnas grundfärger. Av färgerna är bara accenten organisationens.
- Standardloggan, Eneos ordmärke i en ljus och en mörk variant (`frontend/public/brand/`).
- Ikonen i fliken och på hemskärmen, Eneos märke: `frontend/public/favicon.svg` och `apple-touch-icon.png` (180 × 180 px, vitt på Eneos blå, utan rundade hörn eftersom telefonen rundar dem). En organisations logga är för bred för en ikon.
- Färgen på webbläsarens list ovanför sidan (`theme-color` i `frontend/index.html`). Den följer systemets ljusa eller mörka läge, inte valet under **Tema**.
