# Inspelaren

## Format

Inspelaren använder ett komprimerat webbläsarformat, i första hand WebM/Opus när flödet accepterar det (Safari: `audio/mp4`), i mono och med en bithastighet som passar tal. Den ber `MediaRecorder` om korta delar (2 sekunder), så att långa möten inte bygger upp en enda stor intern buffer: ett möte på fem timmar blir i Chrome ungefär 72 MB. Eneo-körningen startar först när hela ljudfilen har laddats upp och ett `file_id` finns. Strömma strömmar bara en förhandstext, se [Eneo-integration](eneo-integration.md#live-text-strömma).

## Inspelningen sparas på enheten

Inspelaren sparar en ljudbit varannan sekund i webbläsarens IndexedDB (`frontend/lib/recording-store.ts`). En omladdning, en krasch eller en utgången session förlorar därför högst den senaste biten.

- Inspelningen visas som osänd i flödeslistan och på flödets sida, med **Skicka**, **Spara som fil** och **Ta bort**, för den som spelade in den.
- Den lokala kopian tas bort först när Eneo har tagit emot körningen.
- Utan IndexedDB (vissa privata lägen) finns inspelningen bara i fliken, och det står i inspelaren.

## Fortsätta en inspelning

Tappar inspelningen mikrofonen, till exempel vid ett samtal eller när en telefon lägger sidan i bakgrunden, pausas den och **Fortsätt spela in** startar en ny del.

- Det går också efter en omladdning: en inspelning som avbröts utan stopp visas som osänd på flödets sida, och **Fortsätt spela in** spelar in i en ny del av samma inspelning. Efter **Stoppa** finns knappen också bredvid **Skapa dokument**, tills inspelningen har börjat skickas.
- En dold sida eller en flik som stängs sparar den pågående biten direkt. Att sidan bara döljs pausar inte, eftersom en laptop spelar in vidare i en bakgrundsflik.

## Delar och filgränser

Innan en del når flödets största filstorlek startar nästa del på samma mikrofon, och när flödets sista fil är full stoppas inspelningen med ett meddelande. Allt som spelats in finns kvar. Delarna skickas i ordning som filer i samma körning, med inspelningens egen idempotensnyckel, så att Eneo gör en körning per inspelning även om två flikar skickar den.

## En flik i taget

En inspelning används av en flik i taget. Den flik som spelar in den, skickar den eller tar bort den håller ett lås (Web Locks) som webbläsaren släpper när fliken stängs eller kraschar. Andra flikar visar inte inspelningen som osänd så länge, och **Skicka** eller **Ta bort** där nekas med ett meddelande. Utan Web Locks (Safari före 15.4) kan bara fliken som spelade in en inspelning skicka, fortsätta eller ta bort den; andra flikar kan spara den som fil.

## Uppladdning och nya försök

Uppladdning och start av körning försöker igen vid tillfälliga fel (nätverksfel, 408, 429 och 5xx) och direkt när anslutningen är tillbaka; körningen startas med samma idempotensnyckel vid varje försök (`frontend/lib/submit-run.ts`). Andra 4xx-fel stoppar med Eneos felmeddelande. Ett avbrott i nätet väntas ut hur länge som helst.

Efter fyra försök som ger serverfel visas "Det gick inte att skicka". Inspelningen ligger kvar i webbläsaren och kan skickas igen med "Försök igen".
