# Inspelaren

Syfte: Beskriva hur inspelningen fångas, sparas på enheten, fortsätts och skickas, så att ett möte inte går förlorat.

Läs detta när: Du ändrar något i `frontend/lib/recording-*.ts`, uppladdningen, de osända inspelningarna, eller ska förklara varför en inspelning finns kvar eller nekas.

Hör ihop med: [Eneo-integration](eneo-integration.md), [Frontend](frontend.md#var-tillståndet-bor), [Inloggning och session](auth-and-session.md#när-inloggningen-har-gått-ut), [Granska transkriptet](transcript-review.md)

## Format och buffring

- Inspelaren använder ett komprimerat webbläsarformat, i första hand WebM/Opus när flödet accepterar det, och ber `MediaRecorder` om korta chunks (2 sekunder, `CHUNK_MS`). Det minskar risken att långa möten bygger upp en enda stor intern recorder-buffer.
- Tal spelas in i mono med 32 kbit/s (`SPEECH_RECORDING` i `frontend/lib/recording-session.ts`), med Opus när webbläsaren kan och annars webbläsarens eget format (Safari: `audio/mp4`). Ett möte på fem timmar blir ungefär 72 MB.
- Chromes WebM-filer saknar längd i sitt huvud. När en del sätts ihop till en fil skrivs den inspelade längden dit (`frontend/lib/webm-duration.ts`), så att uppspelningen visar rätt längd och går att spola i.
- Eneo-körningen startar fortfarande först när hela ljudfilen har laddats upp och ett `file_id` finns. Strömma strömmar bara en förhandstext, se [Eneo-integration](eneo-integration.md#live-text-strömma).

## Inspelningen sparas på enheten

Inspelaren sparar en ljudbit varannan sekund i webbläsarens IndexedDB, under inspelningens id, del och löpnummer (`frontend/lib/recording-store.ts`). En omladdning, en krasch eller en utgången session förlorar därför högst den senaste biten.

- Inspelningen visas som osänd i flödeslistan och på flödets sida, med **Skicka**, **Spara som fil** och **Ta bort**, för den som spelade in den.
- Den lokala kopian tas bort först när Eneo har tagit emot körningen.
- Utan IndexedDB (vissa privata lägen) finns inspelningen bara i fliken, och det står i inspelaren. Samma sak om enheten vägrar en skrivning: `persistent` blir då falskt.

## Fortsätta en inspelning

Tappar inspelningen mikrofonen, till exempel vid ett samtal eller när en telefon lägger sidan i bakgrunden, pausas den och **Fortsätt spela in** startar en ny del.

- Det går också efter en omladdning: en inspelning som avbröts utan stopp visas som osänd på flödets sida med **Fortsätt spela in**, som spelar in direkt i en ny del av samma inspelning, med tiden räknad från det som redan sparats.
- Efter **Stoppa** finns **Fortsätt spela in** också bredvid **Skapa dokument**: det spelar in en ny del av samma inspelning, tills inspelningen har börjat skickas. Med Strömma kommer livetexten tillbaka för den nya delen.
- En kort tystnad i mikrofonen (ett headset som byter väg) pausar inte: inspelningen fortsätter, säger det (`muted`) och är sig själv igen när samma spår tas upp igen.
- En dold sida eller en flik som stängs sparar den pågående biten direkt, så att en sida som systemet dödar förlorar så lite som möjligt. Att sidan bara döljs pausar inte, eftersom en laptop spelar in vidare i en bakgrundsflik.

## Delar och filgränser

- Innan en del når flödets största filstorlek startar nästa del på samma mikrofon. Marginalen räknas från bithastigheten och chunkintervallet, och de två delarna spelar in samtidigt i 150 ms (`ROTATION_OVERLAP_MS`), eftersom Chrome tappar de sista millisekunderna före ett stopp.
- När flödets sista fil (`max_files`) är full stoppas inspelningen med ett meddelande, och allt som spelats in finns kvar. Återstående inspelningstid finns i inspelarens tillstånd (`remainingMs`).
- En del som inte fick något ljud räknas inte som fil.
- Delarna skickas i ordning som filer i samma körning (`file_ids`), med inspelningens egen idempotensnyckel, så att Eneo gör en körning per inspelning även om två flikar skickar den.

## En flik i taget

En inspelning används av en flik i taget. Den flik som spelar in den, skickar den eller tar bort den håller ett lås (Web Locks) som webbläsaren släpper när fliken stängs eller kraschar.

- Andra flikar visar inte inspelningen som osänd så länge, och **Skicka** eller **Ta bort** där nekas med ett meddelande.
- Utan Web Locks (Safari före 15.4) kan bara fliken som spelade in en inspelning skicka, fortsätta eller ta bort den. Andra flikar, och samma flik efter en omladdning, kan spara den som fil.

## Uppladdning och nya försök

Uppladdning och start av körning försöker igen vid nätverksfel, 408, 429 och 5xx, med en väntetid som börjar på 1 s och fördubblas upp till 60 s, och direkt när anslutningen är tillbaka. Körningen startas med samma idempotensnyckel vid varje försök. Andra 4xx-fel stoppar med Eneos felmeddelande (`frontend/lib/submit-run.ts`).

- Eneo svarade med serverfel på fyra försök att ladda upp samma fil (nätavbrott och 429 räknas inte): då visas "Det gick inte att skicka". Inspelningen ligger kvar i webbläsaren och kan skickas igen med "Försök igen".
- Ett avbrott i nätet väntas ut hur länge som helst. Själva körningsbegäran och uppföljningen av en körning ger aldrig upp på serverfel.
- Upload-timeouten räknas från `runtime_upload_policy` i flödets kontrakt och uppladdningen hålls vid liv så länge progress fortsätter, i stället för en hårdkodad gräns.
- Medan webbläsaren är offline eller inte når modulen säger sidan det och väntar (`frontend/lib/online-status.ts`).

## Mikrofonen

- Mikrofonen och "Testa mikrofonen" är ett frivilligt prov före inspelning (`frontend/components/flow/MicrophoneCheck.tsx`). Mikrofonen begärs först när användaren trycker på knappen.
- Valet av mikrofon kommer ihåg per webbläsare och begärs som `ideal`, så att en urkopplad enhet faller tillbaka på standard i stället för att inspelningen misslyckas (`frontend/lib/microphone.ts`).
- Nivån visas av `frontend/components/flow/LevelMeter.tsx`.
