# 0001. Astryx i stället för shadcn, Radix och Tailwind

Syfte: Förklara varför modulens gränssnitt byggs av Astryx och inte av kopierade shadcn-komponenter.

Läs detta när: Du undrar varför det finns två UI-system i trädet, vill föra in en komponent från shadcn, eller överväger att byta designsystem eller uppgradera Astryx.

Hör ihop med: [Designsystem](../design-system.md), [Frontend](../frontend.md), [Beslutslogg](README.md)

Status: Accepterat, införs (portningen pågår, se Migration). Datum: 2026-10-01.

## Sammanhang

Modulens gränssnitt bestod av 26 kopierade shadcn-filer, 16 `@radix-ui/*`-paket, Tailwind 3.4, cva och tailwind-merge. Varje modul som byggdes så skulle äga och underhålla en egen kopia av ett UI-system, med ett eget sätt att styla.

Huset har dessutom krav över WCAG: 44 px pekmål och mätta fokusindikatorer. De ska uppfyllas en gång, inte vid varje anrop.

En provkörning i en kopia av frontend (Astryx 0.6.3 bredvid Tailwind) klarade modulens egen tillgänglighetsgrind efter tre rättelser som gjordes en gång, i temat:

| Brist i Astryx standard | Rättelse |
|---|---|
| Menyrader och val är 36 px | 44 px under grov pekare |
| Fält och väljare visar fokus bara som en ändrad kantfärg, som grindens 3:1-mätning avvisar | Fokusring på fält och väljare |
| Den vita etiketten på felfärgen i mörkt läge är 3,76:1 | Mörk etikett, 5,4:1 |

Provkörningen visade också att Astryx fungerar under modulens CSP i Chromium och WebKit, och att modulens enhetstester överlever efter tre ändringar i testmiljön (jsdom saknar `showModal` och Popover API).

## Beslut

Gränssnittet byggs av Astryx-komponenter och layoutprimitiver, ett byggt Eneo-tema och CSS-moduler med Astryx-tokens för de få specialytorna (transkripttext med ordspann, nivåmätare, den fastlåsta spelaren). Tailwind, Radix, kopierade shadcn-filer, cva och tailwind-merge tas bort. next-themes stannar ([0003](0003-next-themes-owns-the-colour-mode.md)).

- Portningen sker per yta, inte per primitiv: ramen först, och en yta byter primitiver och layout tillsammans, kontrollerad av grinden för den ytan.
- Ingen paketgräns under portningen: temat och providers ligger i en vanlig mapp, `frontend/kit/`, utan eget `package.json`.
- Next.js behålls under portningen, så att ett fel inte kan skyllas på både byte av körmiljö och av UI-bibliotek.
- Widgetar byts mot Astryx motsvarighet (`Typeahead`, `Tokenizer`, `FileInput` och liknande) först när widgetens egna tester klarar den, eftersom namnen inte bevisar samma tangentbords-, klistra-in-, fokus- och uppläsningsbeteende.
- En brist i designsystemet rättas en gång i temat ([Designsystem](../design-system.md#rätta-en-brist-i-designsystemet)).

Starkaste alternativet var Tailwind 4 med Astryx tokenbrygga: en andra migrering och ett andra stylingsystem i varje framtida modul, medan specialytorna är få och lokala.

## Konsekvenser

- Astryx är före 1.0 (beskrivet som beta). Kärnan och CLI:t är fastlåsta exakt, och en uppgradering är en egen pull request med full grind; återställning är att backa den.
- Äldre webbläsare får oförankrade menyer ([Designsystem](../design-system.md#astryx-i-korthet)).
- Agenter behöver två undantag från det genererade blocket i `frontend/AGENTS.md`: ingen Tailwind i ny kod, och CSS-moduler är tillåtna på namngivna specialytor. De står i rot-`AGENTS.md`.
- Stoppvillkor: behåll det gamla systemet om en webbläsare som stöds misslyckas med inloggning, inspelning, sändning eller granskning, om ett sessionsskydd inte går att rätta utan att kopiera Astryx internals, om en grundkontroll kräver en förgrenad komponent för att klara grinden, eller om ett tröskelvärde i grinden måste sänkas. Vanliga temarättelser är inget stoppvillkor.

## Migration (temporary, removed by bead .24)

- Systemen samexisterar genom explicita cascade-skikt (`frontend/app/layers.css`) tills sista fasen. En spärr (`frontend/lib/legacy-ui.test.ts`, listan `frontend/tests/legacy-ui-files.json`) räknar filerna som ligger kvar på det gamla systemet; listan krymper bara.
- Plan och underlag: `docs/plans/2026-10-01-astryx-port-plan.md` och `docs/plans/2026-10-01-module-platform-design.md`.
