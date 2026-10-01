# Granska transkriptet

Syfte: Beskriva för en användare hur talargranskningen i spelaren fungerar, och för en utvecklare hur den slås på.

Läs detta när: Du ska förklara eller testa granskningen (markera ord, tilldela talare, rätta text), slå på funktionen, eller hitta rätt dokument om dess leverans.

Hör ihop med: [Eneo-integration](eneo-integration.md#granskning-och-talarmappning), [Inspelaren](recording.md), [Leveransstatus](speaker-review-rollout.md), [Eneo-överlämningen](handover-eneo-transcript-editor-2026-09-15.md), [Tillgänglighetsgranskningen](accessibility-review-2026-09-15.md)

## Slå på granskningen

Granskningskontrollerna är valfria. Evidensen bevaras alltid.

| Inställning | Värde | När den läses |
|---|---|---|
| `NEXT_PUBLIC_SPEAKER_REVIEW_ENABLED` | `true` slår på kontrollerna, annars av | Vid byggtid för frontend (`frontend/lib/speaker-review.ts`). Imagen och Compose tar den som byggargument, standard `false`. |

- Lokalt: sätt den i `.env`, läs in `.env` i terminalen före `npm run dev` och starta om frontend efter ändringen. Se [Lokal utveckling](development.md).
- Att skriva talare kräver stöd för v3 i Eneo. Inställningen väljer inte Eneo till granskning av typen Vemsa.

## Granska i spelaren

Med granskningen på visar spelaren ett sammanhängande transkript.

- **Markera ord** direkt med musen, eller med Skift och piltangenter, och välj **Tilldela talare**. Markeringen kan gå över flera ursprungliga textfragment.
- **Bekräfta [namn]** accepterar ett gemensamt talarförslag med ett klick.
- **Lyssna** spelar markeringen med lite sammanhang.
- Klicka på ett ord med heldragen understrykning för att flytta uppspelningen dit. Pausat ljud förblir pausat och pågående uppspelning fortsätter från den nya positionen. Om ordtiden saknas används passagens start. Det aktuella ordet visas med en tydlig blå bakgrund.
- **Rätta text** ändrar orden.
- **Ångra** återställer den senaste ändringen och **Återställ talare** tar bort beslut för de markerade orden.

Prickad understrykning visar ord där talaren behöver granskas.

- Klicka på passagen för att markera hela, inklusive skiljetecken, eller använd Enter när den har fokus. Dra över text för att välja en mindre del.
- **Nästa** markerar nästa sådant ställe.
- Överlappsdetaljer finns under **Detaljer**.
- Namn som gäller hela talaren ändras separat under **Talare** ovanför transkriptet.

## Var koden finns

| Sökväg | Innehåll |
|---|---|
| `frontend/components/TranscriptEditor.tsx`, `frontend/components/TranscriptPlayer.tsx` | Editorn och spelaren. |
| `frontend/components/SpeakerNamingDialog.tsx`, `frontend/components/NameCombobox.tsx` | Namngivning av talare. |
| `frontend/lib/speaker-review.ts`, `frontend/lib/transcript-selection.ts`, `frontend/lib/transcript-corrections.ts` | Logiken: granskningsdata, markering, rättningar mot Eneo. |
| `frontend/app/dev/speaker-review/` | Utvecklingssida med fixturer, bara i `next dev`. |
| `frontend/tests/fixtures/speaker_review.json` | Fixtur för tester. |

Kontraktet mot Eneo (checkpoints, talarmappning, rättningar) står i [Eneo-integration](eneo-integration.md#granskning-och-talarmappning).
