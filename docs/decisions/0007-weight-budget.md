# 0007. Viktbudget för sidor

Syfte: Fastställa att sidornas vikt och minnesläckor mäts av tester, så att modulen inte blir långsammare eller tyngre i det tysta.

Läs detta när: `weight.spec.ts` eller `leaks.spec.ts` fallerar, du lägger till ett beroende eller ett överlägg, eller överväger att höja en budget.

Hör ihop med: [Kvalitetsgrindar](../quality-gates.md#produktionssmoke-och-viktbudget), [Frontend](../frontend.md), [Beslutslogg](README.md)

Status: Accepterat, infört. Datum: 2026-10-01 (`9bd5542`, och `60cc1c3` för utvecklingssidan).

## Sammanhang

Byte av UI-system kan göra modulen tyngre, särskilt medan två system ligger i bygget. Mätt på ett produktionsbygge av `main` den 2026-10-01 (Chromium, komprimerad överföring): `/flows` 226 KB JS och 15,6 KB CSS, `/flows/:id` 359 KB JS och 15,6 KB CSS. På en strypt telefon (4x CPU, 1,6 Mbit/s, 150 ms): LCP 2,4 s respektive 2,8 s, total blockeringstid 100–134 ms, JS-minne 4–6 MB.

## Beslut

Vikt och läckor mäts i produktionsbygget, och ett test stoppar när mätvärdet överstiger budgeten:

- `frontend/tests/prod/weight.spec.ts` stoppar när en sidas komprimerade JS och CSS överstiger `frontend/tests/prod/weight-budget.json`.
- Det byggda temat ska användas: inget `<style data-astryx-theme*>` får finnas efter laddning, för det är temagenerering i webbläsaren vid varje sidladdning.
- `frontend/tests/e2e/leaks.spec.ts` öppnar och stänger varje överlägg 40 gånger och jämför Chromiums DOM-räknare, lyssnare och minne.
- Inget laddas som sidan inte använder: en språkfil, ikonuppsättning eller komponent importeras där den används, inte via en gemensam samlingsfil.
- Utvecklingssidan `/dev/foundation` kompileras bara in när bygget ber om det (`FOUNDATION_CHECK=1`). Utan det finns ingen av dess kod i imagen; dess blotta närvaro flyttade delade bitar och kostade `/flows` omkring 3,6 KB.

## Konsekvenser

- Budgeten följer testbygget, som innehåller utvecklingssidan och därför är omkring 6,5 KB över imagen (2026-10-01: imagen `/flows` 291,7 KB, `/flows/:id` 424,1 KB; testbygget 298,1 och 430,7).
- En ändring som höjer budgeten säger varför i sin pull request. Slacken i läckkontrollen höjs aldrig för att få ett test att passera.
- Ett nytt överlägg läggs i `leaks.spec.ts` i samma ändring.

## Migration (temporary, removed by bead .24)

- Budgeten är tillfälligt högre medan det gamla och det nya UI-systemet ligger i bygget. Portningens sista fas sätter tillbaka den till högst basnivån ovan.
- Mät före och efter en fas med `node docs/plans/page-cost.cjs <frontend-mapp> <bas-url> <etikett>`.
