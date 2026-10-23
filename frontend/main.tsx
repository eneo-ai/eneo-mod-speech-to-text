import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
// The order matters: the cascade layers first, the design system's own styles, the Eneo theme, then the module's.
import "./styles/layers.css";
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "@/kit/theme/built/eneo.css";
import "./styles/globals.css";
import { router } from "./routes";
import figtree from "@fontsource-variable/figtree/files/figtree-latin-wght-normal.woff2?url";

// Figtree, Eneo's face: the package's hashed same-origin file (CSP font-src 'self'), the latin one, all Swedish text needs.
// Declared here, with the app, and not in the page's stylesheet: a font face in the head's stylesheet keeps Safari from
// painting anything until the app's code has run, where the page is meant to show its ground in the reader's colour mode
// (tests/prod/first-paint.spec.ts).
document.fonts.add(new FontFace("Figtree Variable", `url(${figtree}) format("woff2")`, { weight: "300 900", display: "swap" }));

// The route's own effects own the scroll after a navigation; the browser must not restore it first.
history.scrollRestoration = "manual";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
