# Inspelaren

## Format

Inspelaren använder ett komprimerat webbläsarformat, i första hand WebM/Opus när flödet accepterar det (Safari: `audio/mp4`), i mono och med en bithastighet som passar tal. Den ber `MediaRecorder` om korta delar (2 sekunder), så att långa möten inte bygger upp en enda stor intern buffer: ett möte på fem timmar blir i Chrome ungefär 72 MB. Eneo-körningen startar först när hela ljudfilen har laddats upp och ett `file_id` finns. Strömma strömmar bara en förhandstext, se [Eneo-integration](eneo-integration.md#live-text-strömma).

## Inspelningen sparas på enheten

Inspelaren sparar en ljudbit varannan sekund i webbläsarens IndexedDB (`frontend/lib/recording-store.ts`). När lagringen fungerar finns de sparade bitarna kvar efter en omladdning, en krasch eller en utgången session; den senaste biten kan gå förlorad.

- Inspelningen visas som osänd i flödeslistan och på flödets sida, för den som spelade in den. Knappen heter **Skapa text** eller **Skapa dokument**, beroende på flödets resultat; på flödets sida läggs **av inspelningen** till. Där finns också **Spara som fil** och **Ta bort**.
- Den lokala kopian tas bort när Eneo har tagit emot körningen eller när du väljer **Ta bort**. Appen har ingen automatisk tidsgräns för osända inspelningar.
- Utan IndexedDB (vissa privata lägen) finns inspelningen bara i fliken, och det står i inspelaren.

Utloggning tar inte bort sparade inspelningar. Inloggningssidan förklarar detta efter utloggning (`frontend/routes/LoginPage.tsx`); logga in med samma konto i samma webbläsarprofil för att fortsätta. Använd en egen webbläsarprofil om du delar dator med andra. Ljudet ligger i profilen, och modulens inloggning skyddar inte mot någon som kan läsa profilens lokala lagring.

Om lagringen slutar fungera, till exempel när webbplatsdata rensas under inspelningen, visas en varning direkt. Inspelningen fortsätter i fliken, men tidigare ljud kan ha försvunnit. Välj **Spara som fil** efter **Stoppa** för att behålla det som finns kvar. Ljud som rensats från enheten går inte att återställa.

## Fortsätta en inspelning

Om mikrofonens ljud tillfälligt försvinner men dess ljudspår finns kvar, visar inspelaren en varning. Ljudet kommer tillbaka automatiskt när mikrofonen är tillgänglig igen. Om ljudspåret avslutas avbryts inspelningen; **Fortsätt spela in** öppnar då mikrofonen och startar en ny del av samma inspelning.

- Det går också efter en omladdning: en inspelning som avbröts utan stopp visas som osänd på flödets sida, och **Fortsätt spela in** spelar in i en ny del av samma inspelning. Efter **Stoppa** finns knappen också bredvid **Skapa dokument**, tills inspelningen har börjat skickas.
- En dold sida eller en flik som stängs sparar den pågående biten direkt. Att sidan bara döljs pausar inte, eftersom en laptop spelar in vidare i en bakgrundsflik.

## Delar och filgränser

Innan en del når flödets största filstorlek startar nästa del på samma mikrofon, och när flödets sista fil är full stoppas inspelningen med ett meddelande. Allt som spelats in finns kvar. Delarna skickas i ordning som filer i samma körning, med inspelningens egen idempotensnyckel, så att Eneo gör en körning per inspelning även om två flikar skickar den.

## En flik i taget

En inspelning används av en flik i taget. Den flik som spelar in den, skickar den eller tar bort den håller ett lås (Web Locks) som webbläsaren släpper när fliken stängs eller kraschar. Andra flikar visar inte inspelningen som osänd så länge. Om en annan flik hinner ta låset innan en åtgärd sker nekas åtgärden med ett meddelande. Utan Web Locks (Safari före 15.4) kan bara fliken som spelade in en inspelning skicka, fortsätta eller ta bort den; andra flikar kan spara den som fil.

## Uppladdning och nya försök

Uppladdning och start av körning försöker igen vid tillfälliga fel (nätverksfel, 408, 429 och 5xx) och när anslutningen är tillbaka. Andra 4xx-fel stoppar med Eneos felmeddelande (`frontend/lib/submit-run.ts`).

Under uppladdningen väntas nätavbrott ut tills anslutningen är tillbaka eller användaren väljer **Avbryt**. Efter fyra uppladdningsförsök som ger 408 eller 5xx visas ett fel. Inspelningen ligger kvar och kan skickas igen med **Försök igen**.

Filer över 4 MiB skickas i delar. Efter ett nätavbrott fortsätter överföringen från senast bekräftade del så länge samma sida och backendprocess finns kvar och gränserna för mottagning och uppehåll inte har passerats. [Driftguiden](operations.md#uppladdningens-tillfälliga-lagring) beskriver tidsgränserna. Mindre filer skickas om hela. Om Eneo har fått den färdiga filen men dess svar eller modulens kvittens saknas gör appen inget automatiskt nytt försök: den visar att mottagandet inte kunde bekräftas och låter användaren välja **Försök igen**. Inget flöde startas utan ett bekräftat fil-id. Beteendet finns i `frontend/lib/api.ts` och `frontend/lib/submit-run.ts`.

När filen är uppladdad visas **Startar flödet**. **Avbryt** finns från början och behåller filen för ett nytt försök. Starten får tio automatiska försök under ungefär fem minuter. Därefter visas **Försök igen** och **Avbryt**. Ett nytt försök använder den redan uppladdade filen och samma idempotensnyckel, så att det inte skapar dubbla körningar. För inspelningar finns också **Spara som fil**.

En vald fil behöver väljas igen om sidan laddas om under **Startar flödet**. Filen finns kvar på datorn.
