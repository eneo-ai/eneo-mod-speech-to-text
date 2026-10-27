# Inspelaren

Inspelaren sparar mötet på enheten medan det spelas in, säger till direkt när något hindrar det och skickar inspelningen till Eneo först när du väljer det. Den här sidan beskriver vad som händer och vad användaren ser, i den ordning det sker.

## Inspelningen sparas på enheten

Varannan sekund skrivs en ljudbit till webbläsarens IndexedDB (`frontend/lib/recording-store.ts`), och skrivningen räknas som klar först när den ligger på disken (`durability: "strict"` där webbläsaren har det). Inspelningen finns därför kvar efter en omladdning, en krasch, ett strömavbrott eller en utgången session. Det som går förlorat är ljud som ännu inte har skrivits: vanligen de sista sekunderna, men mer om webbläsaren håller inne ljudet (till exempel när en telefon låser skärmen). En skrivning som enheten inte svarar på inom fyra sekunder räknas som misslyckad, och ljudet hålls då i fliken med en varning (se nedan).

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
| **Enheten kan inte spara mer av inspelningen.** | En skrivning misslyckades två gånger av annat skäl, eller fick inget svar på fyra sekunder (Safari och webbläsarna på iPhone kan lämna en skrivning obesvarad när sidan har legat i bakgrunden). Ljudet hålls i flikens minne. | Välj **Spara ljudfil** efter **Stoppa** om varningen står kvar. |
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
- **Fortsätt spela in** ber om mikrofonen i samma tryck som **Starta inspelning**, så att Safari använder sitt tidigare svar och frågar igen efter ett nej. Nivåmätarens ljud startas i samma tryck, eftersom Safari bara startar ljud i ett tryck: mätaren visar ljudet också när webbläsaren först har frågat om mikrofonen (`frontend/components/flow/LevelMeter.tsx`).
- En dold sida eller en flik som stängs sparar den pågående biten direkt. Att sidan döljs pausar inte, eftersom en laptop spelar in vidare i en bakgrundsflik.

## Inspelningar som inte har skickats

En inspelning som inte har skickats visas i flödeslistan och på flödets sida, bara för den som spelade in den.

- **Knapparna:** **Skapa text** eller **Skapa dokument** (efter flödets resultat), **Spara ljudfil**, **Ta bort**, och för en avbruten inspelning **Fortsätt spela in**. Upp till 640 px bredd står den första över hela kortet. De inramade efter den (skickandet efter **Fortsätt spela in**, och **Spara ljudfil**) delar en rad där de får plats och står annars under varandra, och **Ta bort** står sist i deras rad i sin egen bredd. Bredare står alla i en rad, med **Ta bort** sist.
- **Flera inspelningar:** flödeslistan visar den senaste avbrutna, eller annars den senaste. De andra ligger under till exempel **2 inspelningar till**, stängt från början.
- **Spara ljudfil** sparar hela inspelningen på ett tryck. En inspelning i delar sparas som en zip-fil med alla delar, eftersom webbläsare stoppar eller frågar om flera nedladdningar på ett tryck; knappen säger då till exempel **Spara 3 ljudfiler (zip)**. Zip-filen heter som inspelningen, till exempel `inspelning-2026-10-26-1103.zip`, och delarna i den heter som de skulle ha hetat var för sig (`frontend/lib/zip.ts`). Medan inspelningen sparas kan ingen annan flik ta bort eller skicka den, i webbläsare med Web Locks.
- När Eneo har tagit emot körningen finns inspelningen inte längre på enheten, utan i Eneo. En körning som misslyckades eller avbröts har **Spara ljudfil** i sitt kort och hämtar ljudet därifrån, delarna i en zip-fil som på enheten (`frontend/components/flow/RunFailure.tsx`). Har Eneo rensat filen säger sidan **Filen finns inte kvar hos Eneo.** Saknas bara någon del sparas de andra, och sidan säger till exempel **Del 2 av 3 finns inte kvar hos Eneo.**
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
| Nätavbrott | Väntar tills anslutningen är tillbaka eller du väljer **Avbryt**. |
| 408, 429 eller 5xx | Försöker igen. Efter fyra försök med 408 eller 5xx visas ett fel och **Försök igen**. |
| Annat 4xx | Stoppar med Eneos felmeddelande. |
| Fil över 4 MiB | Skickas i delar och fortsätter från den senast bekräftade delen. En inspelning fortsätter också efter en omladdning eller krasch; en vald fil bara medan sidan finns kvar. [Tidsgränserna](operations.md#uppladdningens-tillfälliga-lagring). |
| Kvittensen saknas | Appen läser modulens kvittens och skickar inte filen igen. Saknas även den visas **Försök igen**. Inget flöde startas utan ett bekräftat fil-id. |
| **Startar flödet** | Tio automatiska försök under ungefär fem minuter, sedan **Försök igen** och **Avbryt starten**, med samma fil och idempotensnyckel. |

Under överföringen och starten står det att sidan ska vara öppen tills flödet har startat. **Avbryt** under överföringen, **Avbryt starten** under starten, eller att lämna sidan inom appen, ber modulen ta bort det den har tagit emot. En vald fil behöver väljas igen om sidan laddas om under **Startar flödet**. Logiken finns i `frontend/lib/submit-run.ts`, `frontend/lib/api.ts` och `frontend/lib/recording-store.ts`.

## Format

WebM/Opus när flödet tar emot det, annars `audio/mp4`, i mono och med en bithastighet för tal. `MediaRecorder` lämnar delar om 2 sekunder, så att ett långt möte inte samlas i en enda buffert; fem timmar blir i Chrome ungefär 72 MB. Eneo-körningen startar först när hela filen är uppladdad. Livetexten är bara en förhandstext ([Eneo-integration](eneo-integration.md#live-text-strömma)).

Före uppladdningen får en WebM-fil det en spelare behöver. Chrome skriver ingen längd, så den skrivs in (`frontend/lib/webm-duration.ts`). Safari markerar inga ljudblock som keyframes, och då kan Chrome och Edge inte spela filen, så varje block markeras med en byte (`frontend/lib/webm-keyframes.ts`).
