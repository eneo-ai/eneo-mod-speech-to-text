# Inloggning och session

Eneo SSO är det enda sättet att logga in. Modulen är ingen egen OIDC-klient: Eneo är installationens autentiseringsauktoritet. Varje session är en `EneoSsoSession` (`backend/app/module_auth.py`): en användare, en tenant och en modultoken, och varje anrop till Eneo bär både servicenyckeln och den token. Adresserna och reglerna för `http` och `localhost` står i [Drift](operations.md#miljövariabler).

## Eneo SSO

1. `GET /api/auth/login` skapar ett oförutsägbart, kortlivat `state`, binder det till en HttpOnly-cookie och skickar webbläsaren till Eneos `/module-login` med `module_key`, `redirect_uri` och `state`.
2. Eneo autentiserar användaren och skickar tillbaka en engångsticket till `/api/auth/callback`.
3. Callbacken verifierar och förbrukar `state` (cookien raderas), växlar ticketen server-side med modulens servicenyckel mot en modultoken, validerar identiteten med ett andra anrop (`/api/v1/module-auth/{module_key}/session/`) och skapar en HttpOnly-modulsession.
4. Varje proxat Eneo-anrop skickar både servicenyckeln och modultoken som BFF:en hämtar ur sessionen.
5. När halva tokenens livslängd har gått förnyar BFF:en den. Nekar Eneo förnyelsen, till exempel när Eneos sessionstak har passerats, avslutas sessionen och användaren loggar in igen.

Callbacken redirectar alltid till en ren URL och svarar med `Referrer-Policy: no-referrer` och `Cache-Control: no-store`. Uvicorns accesslogg är avstängd så att callbackens ticket och state inte hamnar i containerloggar.

### Om callbacken misslyckas

Webbläsaren skickas till `/?auth_error=<kod>`. Sidan visar alltid samma svenska meddelande och tar bort parametern ur adressen; koden är till för felsökning.

| Kod | Betyder |
|---|---|
| `invalid_state` | Ticket eller state saknas eller stämmer inte med state-cookien (som går ut efter 5 minuter). |
| `exchange_unavailable`, `exchange_failed`, `exchange_invalid` | Ticketväxlingen: Eneo nåddes inte, svarade med annat än 200, eller svarade med fel format, fel modul eller en utgången session. |
| `validation_unavailable`, `validation_failed`, `validation_invalid` | Samma tre fall för valideringsanropet, inklusive att identiteten inte stämde med tokenens. |

## Sessionen

Webbläsaren har bara en cookie, `eneo_module_session`, med ett slumpmässigt, opakt ID (HttpOnly, SameSite=Lax, `Secure` när `COOKIE_SECURE=true`). Allt annat ligger i backendens minne: användaren, tenant, modultoken och inloggningens slut. En omstart av backend ger ny inloggning för alla, och en ny inloggning ersätter den gamla sessionen och stänger öppna live-sockets. Utloggning (`POST /api/auth/logout`) tar bort sessionen direkt.

### Hur länge en inloggning gäller

Inloggningens fasta slut är det tidigaste av `SESSION_MAX_AGE_MINUTES` (standard 480, alltså 8 timmar) och Eneos eget sessionstak (`MODULE_AUTH_MAX_SESSION_HOURS` hos Eneo). Bara en ny inloggning kan flytta slutet. `GET /api/auth/status` talar om hur många sekunder som återstår.

### Förnyelse av modultoken

Modultoken är kortlivad och förnyas automatiskt mot Eneo så länge inloggningen gäller, också medan en inspelning pågår utan andra anrop. Går Eneo inte att nå behålls token och förnyelsen provas igen om en stund; nekar Eneo, eller ändras användare, tenant eller modul, avslutas sessionen.

### Förnya inloggningen i förväg

Fem minuter före slutet varnar sidan och erbjuder en ny inloggning i ett eget fönster, utan att lämna sidan, så att inget går förlorat (WCAG 2.2.1). Förnyelsen är bunden till användaren som är inloggad nu: loggar någon annan in avslutas inte sessionen.

### När inloggningen har gått ut

Sidan navigerar inte bort. Den ligger kvar, dold och låst, en pågående inspelning fortsätter att spara på enheten, och en dialog ber om ny inloggning ([beslutet om täckskiktet](decisions/0004-native-dialogs-and-the-session-cover.md)). Medan inloggningen saknas skickas inget från sidan: en förfrågan som tål att skickas två gånger väntar på den nya inloggningen, övriga misslyckas och användaren trycker igen.

### Sidans användare i en gammal flik

Webbläsaren har en cookie för alla flikar. Loggar någon in i en flik ersätts sessionen, och en gammal flik skulle fortsätta skicka ljud, eller ändra något annat, under den nya personens session. Därför namnger en sida den användare den öppnades för, och BFF:en nekar det som ändrar något under `/api/eneo/`, uppladdningarna och live-socketen om namnet saknas eller är ett annat: `409 user_changed`, eller stängning med `1008`. Sidan visar då täckskiktet och läser om sessionsstatus, och inspelningen ligger kvar på enheten. En GET kontrolleras bara om den bär ett namn, eftersom `<audio src>` och en PDF-ram inte kan sätta headers och Eneo auktoriserar själv körningen.

## Vad som aldrig når webbläsaren

| Hemlighet | Var den finns | Hur den hålls borta |
|---|---|---|
| Servicenyckeln (`ENEO_API_KEY`) | Backendens miljö | Läggs på i BFF:en. Bara ett fåtal request-headers går vidare från webbläsaren ([Backend](backend.md#tillåtelselistan-för-eneo-anrop)), så ingen `Authorization`, `Cookie`, `X-API-Key` eller konfigurerad nyckelheader kommer med. |
| Modultoken | Backendens minne, i sessionen | Webbläsaren har bara sessions-ID. |
| Login-ticketen | Passerar en gång i callbackens URL | Callbacken redirectar till en ren URL, ingen referrer, ingen accesslogg. |
| Signerade fil-URL:er | Backendens cache, per session | BFF:en hämtar och strömmar filen; CSP:n tillåter bara same-origin media och ramar. |
| Live-transkriptionens ticket | Backend | Öppnar Eneos WebSocket server-side; webbläsaren ser aldrig ticketen. |
| Eneos cookies och `Location` | Eneos svar | Klienten mot Eneo lagrar och skickar inga cookies, och en omdirigering från Eneo är ett 502. |

## Kontrollen av origin

`require_same_origin` (`backend/app/module_auth.py`) kräver att `Origin` är modulens egen (`MODULE_PUBLIC_URL`) för allt utom GET, HEAD och OPTIONS. En WebSocket-handskakning är en GET men kontrolleras som en mutation, och avvisas med stängningskod 1008 innan anslutningen accepteras.

## Tidsgränser (WCAG 2.2.1)

Inloggningen varnar fem minuter före slutet och kan förnyas utan att lämna sidan. En granskningspaus visar när Eneo avbryter körningen. Kriteriet uppfylls bara när flödets granskningsfönster är längre än 20 timmar; Eneos standard är 14 dagar, och ett flöde som ställer in ett kortare fönster uppfyller det inte.
