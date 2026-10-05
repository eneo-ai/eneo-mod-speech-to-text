# 0007. Viktbudget för sidor

## Sammanhang

Modulen används på telefoner och på kommunala nät. Ett beroende, en ikonuppsättning eller en delad samlingsfil gör sidorna tyngre utan att något syns i en granskning, och ett överlägg som aldrig städas efter sig gör dem långsammare ju längre de är öppna.

## Beslut

Vikt och läckor mäts på bygget som levereras, och ett test stoppar när mätvärdet överstiger budgeten:

- `frontend/tests/prod/weight.spec.ts` stoppar när en sidas komprimerade JS och CSS överstiger `frontend/tests/prod/weight-budget.json`, som har ett tak per sida för JS och för CSS. En budget är det uppmätta värdet avrundat uppåt till närmaste 5 KB.
- Det byggda temat ska användas: inget `<style data-astryx-theme*>` får finnas efter laddning, för det är temagenerering i webbläsaren vid varje sidladdning.
- `frontend/tests/e2e/leaks.spec.ts` öppnar och stänger varje överlägg 40 gånger och jämför Chromiums DOM-räknare, lyssnare och minne.
- Varje sida är en egen bit som hämtas när sidan öppnas, så att den som är på inloggningssidan inte laddar inspelningen eller granskningen. Inget laddas som sidan inte använder: en språkfil, ikonuppsättning eller komponent importeras där den används, inte via en gemensam samlingsfil.
- Utvecklingssidorna (`/dev/...`) finns bara i utvecklingsservern och i `dist-check`, aldrig i `dist/`.

## Konsekvenser

- En ändring som höjer en budget säger varför i sin pull request. Slacken i läckkontrollen höjs aldrig för att få ett test att passera.
- Ett nytt överlägg läggs i `leaks.spec.ts` i samma ändring.
- Vikten mäts bara i Chromium, som rapporterar varje anrops överföringsstorlek. [Tester](../quality-gates.md#produktionstesterna)
