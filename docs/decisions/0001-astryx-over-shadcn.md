# 0001. Astryx som UI-system

**Sammanhang.** Husets krav över WCAG (44 px pekmål, mätta fokusindikatorer) ska uppfyllas en gång, inte vid varje anrop och i varje modul.

**Beslut.** Gränssnittet byggs av Astryx-komponenter och ett byggt Eneo-tema (en brist rättas en gång, i temat), med CSS-moduler och Astryx-tokens för de få ytor som saknar motsvarighet.

**Konsekvens.** Astryx är före 1.0: versionerna är exakt fastlåsta och en uppgradering är en egen ändring med hela gaten; äldre webbläsare får oförankrade menyer ([Frontend](../frontend.md#designsystemet)).
