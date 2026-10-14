# Inspelaren

## Format

Inspelaren använder ett komprimerat webbläsarformat, i första hand WebM/Opus när flödet accepterar det (en webbläsare utan WebM-inspelning: `audio/mp4`), i mono och med en bithastighet som passar tal. Den ber `MediaRecorder` om korta delar (2 sekunder), så att långa möten inte bygger upp en enda stor intern buffer: ett möte på fem timmar blir i Chrome ungefär 72 MB. Eneo-körningen startar först när hela ljudfilen har laddats upp och ett `file_id` finns. Strömma strömmar bara en förhandstext, se [Eneo-integration](eneo-integration.md#live-text-strömma).

Innan en del laddas upp får WebM-filen det en spelare behöver. Chrome skriver ingen längd i filen, så den skrivs in (`frontend/lib/webm-duration.ts`). Safari markerar inga ljudblock som keyframes, och utan den markeringen kan Chrome och Edge inte spola i filen och spelar den inte alls. Därför markeras varje block (`frontend/lib/webm-keyframes.ts`). Ändringen är en byte per block, och resten av filen är oförändrad. Chromes och Firefox filer är redan markerade och lämnas som de är.

## Inspelningen sparas på enheten

Inspelaren sparar en ljudbit varannan sekund i webbläsarens IndexedDB (`frontend/lib/recording-store.ts`). Varje skrivning ligger på disken innan den räknas som klar (IndexedDB:s `durability: "strict"`; en webbläsare utan det alternativet använder sitt eget standardläge). När lagringen fungerar finns de sparade bitarna kvar efter en omladdning, en krasch, ett strömavbrott eller en utgången session; den senaste biten kan gå förlorad.

- Inspelningen visas som osänd i flödeslistan och på flödets sida, för den som spelade in den. Knappen heter **Skapa text** eller **Skapa dokument**, beroende på flödets resultat; på flödets sida läggs **av inspelningen** till. Där finns också **Spara som fil** och **Ta bort**, och för en inspelning som avbröts utan stopp **Fortsätt spela in** (se [Fortsätta en inspelning](#fortsätta-en-inspelning)).
- Den lokala kopian tas bort när Eneo har tagit emot körningen eller när du väljer **Ta bort**. Appen har ingen automatisk tidsgräns för osända inspelningar.
- Utan IndexedDB (vissa privata lägen) finns inspelningen bara i fliken, och det står i inspelaren.

Utloggning tar inte bort sparade inspelningar. Inloggningssidan förklarar detta efter utloggning (`frontend/routes/LoginPage.tsx`); logga in med samma konto i samma webbläsarprofil för att fortsätta. Använd en egen webbläsarprofil om du delar dator med andra. Ljudet ligger i profilen, och modulens inloggning skyddar inte mot någon som kan läsa profilens lokala lagring.

Om enheten blir full under inspelningen visas varningen **Enheten är full.** Inspelningen fortsätter i flikens minne och finns bara där tills det finns plats, så fliken ska inte stängas. Frigör utrymme, till exempel genom att tömma Hämtade filer och papperskorgen. Appen försöker spara på enheten igen var 20:e sekund, och direkt när webbläsarens uppskattning av lagringen visar att det finns plats igen. Det gäller också efter **Stoppa**. När enheten tar emot det som bara fanns i fliken skrivs allt i en enda skrivning, i ordning, och flikens kopia släpps; en skrivning som inte får plats lämnar enhetens kopia som den var. Inspelningsfältet säger en kort stund att inspelningen sparas på enheten igen.

Om en skrivning misslyckas av något annat skäl försöker appen en gång till på en ny anslutning till databasen. Misslyckas även den visas varningen **Enheten kan inte spara mer av inspelningen.** Inspelningen fortsätter i fliken, och appen försöker spara på enheten igen var 20:e sekund, som när enheten är full. När det går skrivs det som bara fanns i fliken till enheten och varningen försvinner. Står varningen kvar när du stoppar: välj **Spara som fil**.

Om webbplatsdata rensas under inspelningen visas en varning direkt. Inspelningen fortsätter i fliken, men tidigare ljud kan ha försvunnit. Välj **Spara som fil** efter **Stoppa** för att behålla det som finns kvar. Ljud som rensats från enheten går inte att återställa.

## Fortsätta en inspelning

Om mikrofonens ljud tillfälligt försvinner men dess ljudspår finns kvar, visar inspelaren en varning. Ljudet kommer tillbaka automatiskt när mikrofonen är tillgänglig igen. Är mikrofonen fortfarande avstängd efter 15 sekunder medan sidan visas, säger varningen vad du kan göra. När ljudet är tillbaka och sidan visas står det i inspelningsfältet hur länge mikrofonen var avstängd, och om det var medan sidan låg i bakgrunden: en telefon kan stänga av mikrofonen för en sida i bakgrunden. Det som sades under tiden finns inte i inspelningen. Om ljudspåret avslutas avbryts inspelningen; **Fortsätt spela in** öppnar då mikrofonen och startar en ny del av samma inspelning.

Medan sidan visas kontrollerar inspelaren varannan sekund att ljudet kommer fram. Har inget ljud kommit på sex sekunder ber den webbläsaren om det, och kommer inget då heller visas varningen **Ljudet sparas inte just nu.** tills ljudet kommer igen. Tiden i inspelningsfältet räknas ändå, men ljud som aldrig kommer fram finns inte i inspelningen; **Stoppa** sparar det som webbläsaren har hållit kvar. En inspelare som har stannat utan att säga det behandlas som en mikrofon som försvunnit: inspelningen pausas och kan fortsätta med **Fortsätt spela in**. Varningen **Vi hör inget från mikrofonen.** (digital tystnad i 15 sekunder) räknas också bara medan sidan visas, och inte medan mikrofonen är avstängd. Nivåmätaren och livetexten startar igen av sig själva när webbläsaren har stängt av deras ljud, till exempel efter ett samtal eller Siri på en iPhone.

- Det går också efter en omladdning: en inspelning som avbröts utan stopp visas som osänd på flödets sida, och **Fortsätt spela in** spelar in i en ny del av samma inspelning. I flödeslistan öppnar samma knapp flödets sida och fortsätter inspelningen där. Efter **Stoppa** finns knappen också bredvid **Skapa dokument**, tills inspelningen har börjat skickas och så länge flödet tar emot ytterligare en del.
- **Stoppa** stoppar direkt, eftersom ett stopp kan ångras med **Fortsätt spela in**. När flödet inte tar emot fler delar av inspelningen, till exempel i ett flöde som tar emot en fil, går stoppet inte att ångra; då frågar **Stoppa** först (**Stoppa inspelningen?**, `frontend/components/flow/FlowInput.tsx`), och **Fortsätt spela in** är det förvalda svaret.
- **Pausa** och **Stoppa** gör ingenting de första 0,7 sekunderna efter att de visats, i inspelningsfältet och i dialogen för ny inloggning, så att ett tryck som var menat för något annat inte avslutar mötet.
- Kan enheten inte bekräfta att en inspelning som pausades när mikrofonen försvann sparades, eller finns inspelningen inte längre på enheten, står det i inspelningsfältet direkt, inte först efter **Stoppa**. Nekas **Fortsätt spela in**, till exempel för att flödet inte tar emot fler delar, står skälet i varningen.
- En dold sida eller en flik som stängs sparar den pågående biten direkt. Att sidan bara döljs pausar inte, eftersom en laptop spelar in vidare i en bakgrundsflik.
- Inspelaren (`frontend/lib/recording-session.ts`) ber webbläsaren hålla skärmen tänd (Screen Wake Lock). Om webbläsaren saknar det, nekar det eller släpper det medan sidan visas står **Låt skärmen vara tänd under inspelningen.** i inspelningsfältet, tills en senare begäran beviljas.

## Delar och filgränser

Innan en del når flödets största filstorlek startar nästa del på samma mikrofon, och när flödets sista fil är full stoppas inspelningen med ett meddelande. Allt som spelats in finns kvar. Delarna skickas i ordning som filer i samma körning, med inspelningens egen idempotensnyckel, så att Eneo gör en körning per inspelning även om två flikar skickar den.

## En flik i taget

En inspelning används av en flik i taget. Den flik som spelar in den, skickar den eller tar bort den håller ett lås (Web Locks) som webbläsaren släpper när fliken stängs eller kraschar. Andra flikar visar inte inspelningen som osänd så länge. Om en annan flik hinner ta låset innan en åtgärd sker nekas åtgärden med ett meddelande. Utan Web Locks (Safari före 15.4) kan bara fliken som spelade in en inspelning skicka, fortsätta eller ta bort den; andra flikar kan spara den som fil.

## Uppladdning och nya försök

Uppladdning och start av körning försöker igen vid tillfälliga fel (nätverksfel, 408, 429 och 5xx) och när anslutningen är tillbaka. Andra 4xx-fel stoppar med Eneos felmeddelande (`frontend/lib/submit-run.ts`).

Under uppladdningen väntas nätavbrott ut tills anslutningen är tillbaka eller användaren väljer **Avbryt**. Efter fyra uppladdningsförsök som ger 408 eller 5xx visas ett fel. Inspelningen ligger kvar och kan skickas igen med **Försök igen**.

Filer över 4 MiB skickas i delar. Efter ett nätavbrott fortsätter överföringen från senast bekräftade del så länge backendprocessen finns kvar och gränserna för mottagning och uppehåll inte har passerats. [Driftguiden](operations.md#uppladdningens-tillfälliga-lagring) beskriver tidsgränserna och kvittensen. En vald fil fortsätter bara medan sidan finns kvar. En inspelning fortsätter också efter en omladdning, en stängd flik eller en krasch: enheten sparar vilken uppladdning varje del har hos modulen, och när inspelningen skickas igen frågar appen modulen hur långt den kom, skickar resten och visar förloppet därifrån. Har modulen inte kvar uppladdningen börjar delen om från början. **Avbryt** under överföringen, eller att lämna sidan inom appen, ber modulen ta bort det den hunnit ta emot; då börjar nästa sändning om delen. Mindre filer skickas om hela.

När hela filen är skickad lämnar modulen den vidare till Eneo; för en inspelning sparar enheten först att det har begärts. Har appen inte fått modulens svar läser den modulens kvittens och använder filens id utan att skicka filen igen, för en inspelning också efter en omladdning eller en krasch. Om Eneos svar till modulen eller modulens kvittens saknas gör appen inget automatiskt nytt försök: den visar att mottagandet inte kunde bekräftas och låter användaren välja **Försök igen**. Det nya försöket skickar filen på nytt, och en fil som Eneo redan hade tagit emot ligger då kvar där utan körning. Inget flöde startas utan ett bekräftat fil-id. Beteendet finns i `frontend/lib/api.ts`, `frontend/lib/submit-run.ts` och `frontend/lib/recording-store.ts`.

När filen är uppladdad visas **Startar flödet**. **Avbryt** finns från början och behåller filen för ett nytt försök. Starten får tio automatiska försök under ungefär fem minuter. Därefter visas **Försök igen** och **Avbryt**. Ett nytt försök använder den redan uppladdade filen och samma idempotensnyckel, så att det inte skapar dubbla körningar. För inspelningar finns också **Spara som fil**.

En vald fil behöver väljas igen om sidan laddas om under **Startar flödet**. Filen finns kvar på datorn.
