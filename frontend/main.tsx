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

// The route's own effects own the scroll after a navigation; the browser must not restore it first.
history.scrollRestoration = "manual";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
