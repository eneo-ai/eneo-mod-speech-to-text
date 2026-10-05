import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";

import { PRODUCT_NAME, documentTitle } from "./product";

test("a page's title is what it is, then the module's name; a page with none has the name alone", () => {
  assert.equal(documentTitle("Välj ett flöde"), `Välj ett flöde · ${PRODUCT_NAME}`);
  assert.equal(documentTitle(), PRODUCT_NAME);
  assert.equal(documentTitle(""), PRODUCT_NAME);
});

// The name is written once. Sentences that speak of the module ("Kontakta den som ansvarar för Tal till text") are
// text for the reader and stay as they are: this looks for the name standing alone, as a label, a heading or a title.
test("the module's name stands alone in one place: lib/product.ts", () => {
  const sources = ["routes.tsx", "main.tsx"].concat(["components", "routes", "lib", "kit"].flatMap((folder) =>
    readdirSync(folder, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.includes("built"))
      .map((file) => `${folder}/${file}`),
  ));
  const alone = /[=(,:]\s*["'`]Tal till text["'`]|>Tal till text<|· Tal till text/;
  const found = sources.flatMap((source) =>
    readFileSync(source, "utf8").split("\n").flatMap((line, index) => (alone.test(line) && source !== "lib/product.ts" ? [`${source}:${index + 1}`] : [])),
  );
  assert.deepEqual(found, []);
});
