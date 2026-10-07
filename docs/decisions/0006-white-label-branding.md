# 0006. Organisationens märke och accent är driftsinställningar

## Sammanhang

Modulen byggdes för Sundsvalls kommun med dess logotyp i sidhuvudet och dess blå som accent, men andra kommuner och myndigheter kör samma image. Ett eget bygge per organisation skulle kräva egna images och en egen byggkedja.

Accentfärgen är inte dekoration: den är färgen på knappar, länkar, ikoner, fokusramen och valda rader. En accent som inte går att läsa mot sidan gör länkar och text oläsliga och fokus osynligt, och en organisation kan inte själv se det innan det är i drift.

## Beslut

Organisationens namn, logotyp och accentfärg är inställningar för driftsättningen, inte en byggparameter ([Byt organisation](../branding.md)). Backend läser dem vid start och skriver märket in i sidans markör, så att första bildrutan redan visar det. Accenten måste nå 4,5:1 mot sidans ytor i båda lägena, och backend stoppar starten med ett enda svenskt felmeddelande om den inte gör det: ett fel som syns vid driftsättningen är bättre än oläsliga länkar hos användarna. 4,5:1 är högre än WCAG:s 3:1 för ramar, eftersom accenten också är text- och länkfärgen: ett enda krav som håller för det värsta bruket är enklare än ett per användning, och det håller fokusramen läsbar på köpet. Allt annat i utseendet är modulens.

## Konsekvenser

- Ett byte av märke syns först efter den omstart som läser inställningarna. En ny accent syns efter omstarten och när webbläsarens kopia av stilmallen gått ut (högst fem minuter).
- En operatör kan få backend att inte starta med en färg som är för ljus eller för mörk; felet står i loggen och förklaras i [Byt organisation](../branding.md#felmeddelanden-vid-start).
- Nya användningar av accenten omfattas av samma krav; `npm run test:a11y:branding` kontrollerar att ingenting i sidan behåller den gamla blå färgen.
- En organisations egna statusfärger eller talarfärger är inte möjliga utan kod.
