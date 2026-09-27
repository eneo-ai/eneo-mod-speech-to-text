import type { Metadata } from "next";
import LoginPage from "./LoginPage";

// The title comes with the page: one set in the browser would lose to the layout's, which streams in after it.
export const metadata: Metadata = { title: "Logga in · Tal till text" };

export default LoginPage;
