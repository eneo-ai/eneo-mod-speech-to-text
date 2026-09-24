"use client";

import { createContext, useContext } from "react";

/**
 * Where overlays (dialogs, menus, lists) open: inside the part of the page that AuthGate's signed-out cover hides
 * and puts out of reach, so they go with it; the document body elsewhere, as the sign-in dialog does.
 */
export const PortalContainer = createContext<HTMLElement | null>(null);

export const usePortalContainer = () => useContext(PortalContainer);
