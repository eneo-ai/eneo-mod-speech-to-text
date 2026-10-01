# Beslut

Syfte: Samla de arkitekturbeslut som formar modulen, ett beslut per fil, så att man kan se varför något är som det är.

Läs detta när: Du undrar varför en lösning ser ut som den gör, vill ändra något som ett beslut förutsätter, eller ska skriva ett nytt beslut.

Hör ihop med: [Dokumentationsindex](../README.md), [Arkitektur](../architecture.md), [Designsystem](../design-system.md)

## Beslutslogg

| Nr | Beslut | Status | Datum |
|---|---|---|---|
| [0001](0001-astryx-over-shadcn.md) | Astryx i stället för shadcn, Radix och Tailwind | Accepterat, införs | 2026-10-01 |
| [0002](0002-fastapi-bff-kept.md) | FastAPI behålls som BFF (inte Hono) | Accepterat | 2026-10-01 |
| [0003](0003-next-themes-owns-the-colour-mode.md) | next-themes äger färgläget | Accepterat, infört | 2026-10-01 |
| [0004](0004-native-dialogs-and-the-session-cover.md) | Native dialoger och täckskiktet vid utgången inloggning | Accepterat, infört | 2026-10-01 |
| [0005](0005-deny-by-default-proxy-and-body-limits.md) | Proxy som nekar som standard, och gränser för storlek | Accepterat, infört | 2026-08-18 (proxyn), 2026-09-11 och 2026-09-23 (gränserna) |
| [0006](0006-white-label-branding.md) | Organisationens märke är en driftsinställning | Accepterat, infört | 2026-09-23 |
| [0007](0007-weight-budget.md) | Viktbudget för sidor | Accepterat, infört | 2026-10-01 |

## Så skriver du ett beslut

Kopiera formen från ett befintligt beslut. Ett beslut per fil, med de här rubrikerna:

- **Status**, **Datum** och en rad om vad beslutet gäller överst.
- **Sammanhang:** vad som tvingade fram beslutet, med belägg (en kommandoutskrift, ett test, en commit).
- **Beslut:** vad vi gör, i presens. Nämn det starkaste alternativet och varför det valdes bort.
- **Konsekvenser:** vad som blir enklare, svårare och vad man måste göra.

Ett beslut ändras inte i efterhand. Ett nytt beslut ersätter det gamla; skriv "Ersatt av 00NN" i det gamla beslutets status. Tillfälligt material (till exempel om portningen) står under rubriken `## Migration (temporary, removed by bead .24)` så att det kan tas bort i ett svep.
