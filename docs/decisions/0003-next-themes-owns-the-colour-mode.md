# 0003. next-themes äger färgläget

Syfte: Förklara varför färgläget (ljust, mörkt, system) ägs av next-themes och inte av Astryx eller en cookie, och hur Astryx följer det.

Läs detta när: Färgläget flimrar, du är frestad att lägga lägestillstånd i `ModuleProviders`, eller du ska ändra hur läget sparas.

Hör ihop med: [Designsystem](../design-system.md), [Frontend](../frontend.md#var-tillståndet-bor), [Beslutslogg](README.md)

Status: Accepterat, infört. Datum: 2026-10-01.

## Sammanhang

Astryx temarot sätter sin egen `color-scheme`. Med ett sparat val som skilde sig från operativsystemets målade den fel läge i 3–5 bildrutor vid sidladdning. next-themes sätter klassen (`dark` eller `light`) på `<html>` före första målningen, med en liten skripttagg, och har redan användarnas sparade val under nyckeln `theme`.

## Beslut

next-themes är ensam ägare av färgläget. Det behåller sin lagringsnyckel och sitt skript före målning, och inget om användarnas sparade val ändras.

- Fyra rader CSS i `frontend/app/globals.css` får Astryx temarot att följa klassen på `<html>`, utan lager så att de vinner över systemets lagrade stilar.
- `ModuleProviders` (`frontend/kit/ModuleProviders.tsx`) läser klassen (med en `MutationObserver`) och ger Astryx samma läge efter hydrering, så att det som läser Astryx JavaScript-tema (`useTheme()`: diagramfärger, canvas) är överens med det som är målat. Läget läses, aldrig sparas där.

Alternativet, en cookie som layouten läser på servern, gav också noll fel bildrutor men kräver en serverläsning, en cookieskrivare och en migrering av befintliga val. Det valdes bort.

## Konsekvenser

- Det finns ett enda ställe som äger läget. Lägg aldrig lägestillstånd i providers eller i temat.
- Beviset är `frontend/tests/e2e/color-mode.spec.ts`: inga bildrutor i fel läge i fyra kombinationer av sparat val och system, och att `useTheme()` följer ändringar.
- En framtida statisk app måste läsa det sparade valet innan React renderar, eftersom ingen serverrendering finns att luta sig mot.
