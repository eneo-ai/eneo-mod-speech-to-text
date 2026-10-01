# 0002. FastAPI behålls som BFF

Syfte: Förklara varför modulens backend förblir FastAPI och inte skrivs om i TypeScript (Hono).

Läs detta när: Någon föreslår att slå ihop frontend och backend i ett språk, ersätta BFF:en, eller undrar vad som måste flyttas om Next.js-servern tas bort.

Hör ihop med: [Backend](../backend.md), [Arkitektur](../architecture.md#läget-i-dag), [Inloggning och session](../auth-and-session.md), [Beslutslogg](README.md)

Status: Accepterat. Datum: 2026-10-01.

## Sammanhang

BFF:en är modulens säkerhetsgräns och den är skriven och testad: state-cookie och ticketväxling, förnyelse av token med en förnyelse åt gången, en sökvägssäker tillåtelselista, Range-strömning och WebSocket-reläets gränser (`backend/app/main.py`, `backend/app/module_auth.py`, `backend/tests/`).

Kostnaden som syns i dag kommer inte från Python utan från Next.js: en rewrite-proxy framför varje anrop, uppladdning och WebSocket, en andra process under supervisord och en Node-binär kopierad in i Python-imagen. Nexts rewrite klonar uppladdningens body i minnet och har gett två dokumenterade fel: en body kapad vid 10 MB och en tystnadsgräns på 30 s (`frontend/next.config.mjs`, [Backend](../backend.md#nextjs-ligger-före-bffen)). FastAPI tar emot uppladdningen som en spoolad fil (`UploadFile`) och skickar vidare filen.

## Beslut

BFF:en förblir FastAPI. Hono hade kunnat göra allt BFF:en gör och har ett riktigt försprång i ett enda språk och ett enda paket för gränssnitt och BFF. Men en omskrivning skulle bygga om och verifiera om state-cookien, ticketväxlingen, förnyelsen, tillåtelselistan, Range-strömningen och WebSocket-gränserna, och Eneos klient `eneo-js` ersätter inget av det. Besparingen i minne eller imagestorlek är inte mätt.

Hono omprövas bara om modulförfattare visar sig skriva mycket BFF-logik per modul och bara kan TypeScript, eller om imagestorlek, starttid eller minne blir en mätt driftbegränsning.

## Konsekvenser

- Det planerade steget är att bygga gränssnittet som statiska filer och servera dem från FastAPI, så att Next-servern, rewrite-hoppet och supervisord försvinner (en process). Det är inte genomfört.
- En naiv "servera filerna med uvicorn" skulle tappa det som Next eller supervisord äger i dag. Det måste föras över uttryckligen:
  - säkerhetsheaders, CSP:n och undantaget för samma-origin-inramning av PDF-förhandsvisning (`frontend/next.config.mjs`);
  - `/health` och port 3001;
  - WebSocket-gränserna 128 KiB per meddelande och 16 i kö, som lever i uvicorns kommandorad i `deploy/supervisord.conf`, med ett test att alla startsätt är överens;
  - en backendreplik, eftersom sessionslagret är processlokalt;
  - routing: djuplänkar till `/flows/<id>`, sidtitlar och fokus efter navigering, tillståndsåterställning vid routebyte, en navigeringsspärr som harmoniserar med `frontend/lib/leave-guard.ts`;
  - `/inloggad` med sina avslagskoder och förnyelsefönstret;
  - de `NEXT_PUBLIC_*`-flaggor som finns, utvecklingsproxyn för API och WebSocket, och att utvecklingssidor inte kommer med i produktion;
  - märket utan att fel organisation visas före initiering, utan ett körbart inline-skript;
  - enkelsidesfallbacken får aldrig svara på en saknad tillgång eller en okänd `/api/*`-sökväg med HTML.
- En provkörning av en Vite-app med Astryx som serverades av FastAPI körde i Chromium och WebKit utan konsol- eller CSP-fel under `script-src 'self'`, utan `unsafe-inline`.
- Ett modulkit i ett eget repo (`eneo-ai/eneo-module-kit`) är planerat att samla BFF och gränssnittsdelar för flera moduler. Den här modulen flyttar över först när det finns en släppt version.
