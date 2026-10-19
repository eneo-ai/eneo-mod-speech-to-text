# Inspelaren

Inspelaren sparar mötet på enheten medan det spelas in, säger till direkt när något hindrar det och skickar inspelningen till Eneo först när du väljer det. Den här sidan beskriver vad som händer och vad användaren ser, i den ordning det sker.

## Inspelningen sparas på enheten

Varannan sekund skrivs en ljudbit till webbläsarens IndexedDB (`frontend/lib/recording-store.ts`), och skrivningen räknas som klar först när den ligger på disken (`durability: "strict"` där webbläsaren har det). Inspelningen finns därför kvar efter en omladdning, en krasch, ett strömavbrott eller en utgången session; bara den senaste biten kan gå förlorad.

- **Utloggning tar inte bort inspelningar.** Logga in med samma konto i samma webbläsarprofil för att fortsätta; inloggningssidan säger det efter utloggning. Ljudet ligger i profilen, så den som delar dator bör ha en egen profil.
- **Utan IndexedDB** (vissa privata lägen) finns inspelningen bara i fliken, och det står i inspelaren.
- **Ingen automatisk rensning.** Den lokala kopian tas bort när Eneo har tagit emot körningen eller när du väljer **Ta bort**.

## Varningar under inspelningen

Inspelningen fortsätter i alla lägen nedan utom när ljudspåret avslutas. Texterna står i inspelningsfältet (`frontend/lib/recording-view.ts`).

| Meddelande | Vad som har hänt | Vad du gör |
|---|---|---|
| **Mikrofonen är tillfälligt borta.** | Ljudspåret finns kvar men ger inget ljud, till exempel under ett samtal. | Inget; ljudet kommer tillbaka av sig själv. Efter 15 s blir det **Mikrofonen är fortfarande avstängd.** med råd. |
| **Inspelningen pausades när mikrofonen försvann.** | Ljudspåret avslutades, eller inspelaren stannade utan att säga det. | **Fortsätt spela in** startar en ny del av samma inspelning. |
| **Ljudet sparas inte just nu.** | Inget ljud har kommit på sex sekunder, inte heller när webbläsaren ombads om det. | Kontrollera mikrofonen. Står varningen kvar: **Stoppa**, och spela in vidare. |
| **Vi hör inget från mikrofonen.** | Digital tystnad i 15 s. | Kontrollera att mikrofonen inte är avstängd. |
| **Enheten är full.** | Diskskrivningen nekades. Ljudet hålls i flikens minne. | Frigör utrymme och stäng inte fliken. |
| **Enheten kan inte spara mer av inspelningen.** | En skrivning misslyckades två gånger av annat skäl. | Välj **Spara ljudfil** efter **Stoppa** om varningen står kvar. |
| **Inspelningen kan inte längre sparas på enheten.** | Webbplatsdata rensades. Tidigare ljud kan vara borta och går inte att återställa. | **Spara ljudfil** efter **Stoppa**. |
| **Det finns lite lagringsutrymme kvar på enheten.** | Webbläsarens uppskattning av lagringen är låg. | Frigör utrymme före ett långt möte. |
| **Mindre än 5 minuter kvar till flödets maxlängd.** | En notis från 15 minuter, en varning från 5. Vid gränsen stoppas och sparas inspelningen. | Inget. |
| **Låt skärmen vara tänd under inspelningen.** | Webbläsaren saknar, nekar eller släppte Screen Wake Lock. | Håll skärmen tänd. |

Efteråt står det hur länge ljud saknades: **Mikrofonen var avstängd i …** (med "medan sidan låg i bakgrunden" när så var fallet), eller, när en telefon tog mikrofonen utan att säga det (Android, minst sex sekunder utan ljud i bakgrunden), **Sidan låg i bakgrunden i … Ljud från den tiden kan saknas.**

**Full eller nekande disk.** Appen försöker spara på enheten igen var 20:e sekund, och direkt när det finns plats, också efter **Stoppa**. Det som bara fanns i fliken skrivs då i en enda skrivning, i ordning, och fältet säger en kort stund att inspelningen sparas på enheten igen.

**Vakthunden.** Medan sidan visas kontrolleras ljudflödet varannan sekund. Tystnadsvarningen och tiden mikrofonen var borta räknas bara medan sidan visas. Nivåmätaren och livetexten startar om av sig själva när webbläsaren har stängt av deras ljud, till exempel efter Siri på en iPhone.

## Pausa, stoppa och fortsätta

- **Stoppa** stoppar direkt, eftersom **Fortsätt spela in** ångrar det. Tar flödet inte emot fler delar, till exempel ett flöde för en fil, frågar **Stoppa** först (**Stoppa inspelningen?**), och **Fortsätt spela in** är förvalt.
- **Pausa** och **Stoppa** gör ingenting de första 0,7 sekunderna efter att de visats, så att ett tryck som var menat för något annat inte avslutar mötet. Medan inspelningen sparas står **Sparar…** på knappen.
- Efter **Stoppa** väntar appen högst fyra sekunder på att webbläsaren bekräftar slutet. Ljud som kommer senare sparas ändå. Utan bekräftelse visas **Webbläsaren har inte bekräftat inspelningens stopp.**, och inspelningen kan inte skickas: spara den med **Spara ljudfil** och ladda upp filen.
- **Fortsätt spela in** fungerar också efter en omladdning: en inspelning som avbröts utan stopp visas som osänd och fortsätter i en ny del. På telefon och surfplatta står den först, under flödets namn. Efter **Stoppa** finns knappen bredvid **Skapa dokument** tills inspelningen börjar skickas.
- En dold sida eller en flik som stängs sparar den pågående biten direkt. Att sidan döljs pausar inte, eftersom en laptop spelar in vidare i en bakgrundsflik.

## Osända inspelningar

En inspelning som inte har skickats visas i flödeslistan och på flödets sida, bara för den som spelade in den.

- **Knapparna:** **Skapa text** eller **Skapa dokument** (efter flödets resultat), **Spara ljudfil**, **Ta bort**, och för en avbruten inspelning **Fortsätt spela in**. Upp till 640 px bredd står de i en stapel över hela kortet, bredare i en rad, med **Ta bort** sist.
- **Flera osända:** flödeslistan visar den senaste avbrutna, eller annars den senaste. De andra ligger under till exempel **2 inspelningar till**, stängt från början.
- **Spara ljudfil** sparar en fil per del och per tryck, eftersom webbläsare stoppar flera nedladdningar på ett tryck. En inspelning i delar säger **Spara som 2 ljudfiler** och sedan **Spara ljudfil 2 av 2**.
- **Inget ljud sparades i den här inspelningen.** En sådan inspelning kan bara fortsättas eller tas bort.
- **Ta bort** säger **Inspelningen togs bort.** till skärmläsare. Fokus går till rubriken där en ny inspelning börjar, eller i listan till listans rubrik, och till sidans rubrik när listan är tom.

### En flik i taget

Den flik som spelar in, skickar eller tar bort en inspelning håller ett lås (Web Locks), och webbläsaren släpper låset när fliken stängs eller kraschar. Andra flikar visar inspelningen med **Inspelningen används i en annan flik.** och utan knappar, och läser om listan när de visas igen. Utan Web Locks (Safari före 15.4) kan bara fliken som spelade in skicka, fortsätta eller ta bort; andra flikar kan spara som fil.

## Skicka inspelningen

### Delar och filgränser

Innan en del når flödets största filstorlek startar nästa del på samma mikrofon. När flödets sista fil är full stoppas inspelningen med ett meddelande, och allt som spelats in finns kvar. Delarna skickas i ordning som filer i samma körning, med inspelningens egen idempotensnyckel, så att två flikar som skickar samma inspelning ger en enda körning.

### Uppladdning och nya försök

| Läge | Vad appen gör |
|---|---|
| Nätavbrott | Väntar tills anslutningen är tillbaka eller du väljer **Avbryt uppladdningen**. |
| 408, 429 eller 5xx | Försöker igen. Efter fyra försök med 408 eller 5xx visas ett fel och **Försök igen**. |
| Annat 4xx | Stoppar med Eneos felmeddelande. |
| Fil över 4 MiB | Skickas i delar och fortsätter från den senast bekräftade delen. En inspelning fortsätter också efter en omladdning eller krasch; en vald fil bara medan sidan finns kvar. [Tidsgränserna](operations.md#uppladdningens-tillfälliga-lagring). |
| Kvittensen saknas | Appen läser modulens kvittens och skickar inte filen igen. Saknas även den visas **Försök igen**. Inget flöde startas utan ett bekräftat fil-id. |
| **Startar flödet** | Tio automatiska försök under ungefär fem minuter, sedan **Försök igen** och **Avbryt**, med samma fil och idempotensnyckel. |

Under överföringen står det att sidan ska vara öppen tills Eneo har filen. **Avbryt uppladdningen**, eller att lämna sidan inom appen, ber modulen ta bort det den har tagit emot. En vald fil behöver väljas igen om sidan laddas om under **Startar flödet**. Logiken finns i `frontend/lib/submit-run.ts`, `frontend/lib/api.ts` och `frontend/lib/recording-store.ts`.

## Format

WebM/Opus när flödet tar emot det, annars `audio/mp4`, i mono och med en bithastighet för tal. `MediaRecorder` lämnar delar om 2 sekunder, så att ett långt möte inte samlas i en enda buffert; fem timmar blir i Chrome ungefär 72 MB. Eneo-körningen startar först när hela filen är uppladdad. Livetexten är bara en förhandstext ([Eneo-integration](eneo-integration.md#live-text-strömma)).

Före uppladdningen får en WebM-fil det en spelare behöver. Chrome skriver ingen längd, så den skrivs in (`frontend/lib/webm-duration.ts`). Safari markerar inga ljudblock som keyframes, och då kan Chrome och Edge inte spela filen, så varje block markeras med en byte (`frontend/lib/webm-keyframes.ts`).
