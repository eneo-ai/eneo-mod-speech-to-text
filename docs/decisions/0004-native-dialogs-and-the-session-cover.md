# 0004. Native dialoger och täckskiktet vid utgången inloggning

Syfte: Fastställa hur sidan döljs och låses när inloggningen har gått ut, och hur det samspelar med native `<dialog>`.

Läs detta när: Du lägger till eller ändrar en dialog, meny eller väljare, ändrar `AuthGate`, eller felsöker att något syns eller går att nå efter att inloggningen gått ut.

Hör ihop med: [Inloggning och session](../auth-and-session.md#när-inloggningen-har-gått-ut), [Frontend](../frontend.md#konventioner), [Kvalitetsgrindar](../quality-gates.md), [Beslutslogg](README.md)

Status: Accepterat, infört. Datum: 2026-10-01.

## Sammanhang

När inloggningen går ut navigerar sidan inte bort: den ligger kvar med allt den håller, en pågående inspelning fortsätter spara på enheten, och en dialog ber om ny inloggning. Sidan är under tiden `inert` och osynlig (`SignedOutCover` i `frontend/components/AuthGate.tsx`).

Tidigare portades Radix-överlägg in i det underträdet och täcktes därför med sidan. Astryx `Dialog` är en native `<dialog>` på plats. En `<dialog>` som öppnas med `showModal()` inuti en `inert`, osynlig förfader är öppen, fokuserbar och synlig i både Chromium och WebKit (kontrollerat med riktiga webbläsare). Täckskiktet kräver därför ett nytt kontrakt.

## Beslut

1. Sidan ligger kvar monterad, `inert` och osynlig.
2. Inloggningsdialogen och frågan "lämna sidan?" är Astryx-dialoger, alltså native, och staplas i öppningsordning.
3. Varje annan dialog eller meny sidan äger stängs medan inloggningen saknas och öppnas igen vid förnyelse med sitt tillstånd i behåll. Tillståndet ligger ovanför dialogen, aldrig inuti den (`useSignedOut()` i `AuthGate`).
4. Inloggningsdialogens bakgrund är ogenomskinlig.
5. Beviset är beteende i en riktig webbläsare, inte en jsdom-assertion på en inert förfader.

## Konsekvenser

- `frontend/tests/e2e/session-cover.spec.ts` är beviset: med namngivningsdialogen öppen och en redigering skriven, avsluta inloggningen; inget av dialogen syns, går att fokusera eller finns i tillgänglighetsträdet; förnya som samma användare; dialogen och redigeringen är tillbaka. Även: utgång medan femminutersvarningen är öppen, bakåt efter utgång, och att Pausa och Stoppa går att nå. Tab hamnar aldrig på sidan bakom.
- Varje ny dialog som sidan äger måste stängas medan inloggningen saknas och ha sitt tillstånd ovanför sig.
- Ett nytt överlägg läggs i `frontend/tests/e2e/leaks.spec.ts` och, om det är en dialog sidan äger, prövas mot täckskiktet.

## Migration (temporary, removed by bead .24)

- En regel i `frontend/app/globals.css` (`dialog[open] { pointer-events: auto; }`) finns för att en Radix-modal stänger av pekhändelser på `<body>`, vilket en native dialog ärver. Den tas bort när den sista Radix-modalen är borta.
