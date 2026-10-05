# 0004. Native dialoger och täckskiktet vid utgången inloggning

## Sammanhang
 När inloggningen går ut navigerar sidan inte bort: den ligger kvar med allt den håller, en pågående inspelning fortsätter spara på enheten, och en dialog ber om ny inloggning. Sidan är under tiden `inert` och osynlig (`SignedOutCover` i `frontend/components/AuthGate.tsx`). Astryx `Dialog` är en native `<dialog>`: en som öppnas med `showModal()` inuti en `inert`, osynlig förfader är ändå öppen, fokuserbar och synlig i Chromium och WebKit, så täcket kan inte lita på förfaderns `inert`.

## Beslut

1. Sidan ligger kvar monterad, `inert` och osynlig.
2. Inloggningsdialogen och frågan "lämna sidan?" är Astryx-dialoger, alltså native, och staplas i öppningsordning.
3. Varje annan dialog eller meny sidan äger stängs medan inloggningen saknas och öppnas igen vid förnyelse med sitt tillstånd i behåll. Tillståndet ligger ovanför dialogen, aldrig inuti den (`useSignedOut()` i `AuthGate`).
4. Inloggningsdialogens bakgrund är ogenomskinlig.
5. Beviset är beteende i en riktig webbläsare, inte en jsdom-assertion på en inert förfader.

## Konsekvenser

- `frontend/tests/e2e/session-cover.spec.ts` är beviset: med namngivningsdialogen öppen och en redigering skriven, avsluta inloggningen; inget av dialogen syns, går att fokusera eller finns i tillgänglighetsträdet; förnya som samma användare; dialogen och redigeringen är tillbaka. Även: utgång medan femminutersvarningen är öppen, Bakåt efter utgång, och att Pausa och Stoppa går att nå. Tab hamnar aldrig på sidan bakom.
- Varje ny dialog som sidan äger måste stängas medan inloggningen saknas, ha sitt tillstånd ovanför sig och läggas i `frontend/tests/e2e/leaks.spec.ts`.
