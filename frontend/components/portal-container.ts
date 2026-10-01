"use client";

import { createContext, useContext } from "react";

/**
 * Where an overlay of the old design system (Radix: a menu, a list) opens: inside the part of the page that
 * AuthGate's signed-out cover hides and puts out of reach, so it goes with the page. The design system's own overlays
 * are native elements of the top layer and need none of this: they close themselves while signed out
 * (useSignedOut) or sit under the sign-in dialog. Goes with the last Radix overlay.
 */
export const PortalContainer = createContext<HTMLElement | null>(null);

export const usePortalContainer = () => useContext(PortalContainer);
