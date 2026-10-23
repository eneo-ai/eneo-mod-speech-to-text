import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Outlet, useLocation, useRouteError } from "react-router";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { LoadingShell } from "@/components/LoadingShell";
import { Brand, BrandingProvider } from "@/components/Brand";
import { ModuleShell } from "@/kit/ModuleShell";
import { ModuleProviders } from "@/kit/ModuleProviders";
import { keepFocusThroughBusy } from "@/lib/focus-keeper";
import { onlineStatus } from "@/lib/online-status";
import { readBranding } from "@/lib/read-branding";
import { RouteEffects, useRouteReady } from "@/routes/RouteEffects";
import { documentTitle, PRODUCT_NAME } from "@/lib/product";

/**
 * What every screen stands in: the colour mode, the design system's providers and who the deployment is for. The
 * organisation is read from the page before the first render, so the frame that shows while the first page's code
 * arrives already has its mark.
 */
function Providers({ children }: { children: ReactNode }) {
  const [branding] = useState(readBranding);
  return (
    <ModuleProviders>
      <BrandingProvider value={branding}>{children}</BrandingProvider>
    </ModuleProviders>
  );
}

/** What every screen stands in: the providers, and the element the page's height and colours hang on. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <Providers>
      <div data-app-shell>{children}</div>
    </Providers>
  );
}

/** The frame of every page: its providers and the page the route names. */
export function Root() {
  // A button its action disabled gets the keyboard focus back when it is enabled again (lib/focus-keeper).
  useEffect(() => keepFocusThroughBusy(document), []);
  return (
    <Frame>
      <RouteEffects />
      <Outlet />
    </Frame>
  );
}

/** While the first page's code arrives: the shell that every page shows while it asks who is signed in, so no frame is blank. */
export function RootHydrateFallback() {
  return (
    <Frame>
      <LoadingShell />
    </Frame>
  );
}

/**
 * What stands where the page asked for cannot: what happened and the ways on, inside the frame. It is a page like any
 * other: its own title, over the title of the route it stands in for, and, reached by a navigation, said with the focus
 * in its heading (`useRouteReady`).
 */
function StandIn({ heading, text, children }: { heading: string; text: string; children: ReactNode }) {
  const { pathname } = useLocation();
  // Again at each address it stands at: the route's own title is set first, at every new path (RouteEffects).
  useEffect(() => {
    document.title = documentTitle(heading.replace(/\.$/, ""));
  }, [heading, pathname]);
  useRouteReady(true);
  return (
    <ModuleShell label={PRODUCT_NAME} heading={<Brand />}>
      {/* The page's column, as the flow list has it, so the heading starts where the bar's brand does at every width. */}
      <Layout height="auto" contentWidth="calc(var(--module-page-width) + var(--spacing-8))" padding={4}>
        <LayoutContent isScrollable={false}>
          <VStack gap={4} paddingBlockStart={4} maxWidth={640}>
            <Heading level={1}>{heading}</Heading>
            <Text as="p" color="secondary">
              {text}
            </Text>
            <HStack gap={3} wrap="wrap">
              {children}
            </HStack>
          </VStack>
        </LayoutContent>
      </Layout>
    </ModuleShell>
  );
}

/**
 * A page that cannot be shown: its code could not be loaded (a tab that was open across a deploy asks for files that
 * are gone), or it threw. It stands in the page's place, inside the providers, and nothing reloads by itself: a person
 * may be in the middle of something on a page that is still open, and a reload is theirs to choose.
 */
export function RouteError() {
  const error = useRouteError();
  useEffect(() => console.error("A page could not be shown:", error), [error]);
  // Without a network the code could not be fetched, and a reload would leave only the browser's own error page: the
  // reload waits for the network.
  const offline = useSyncExternalStore(onlineStatus.subscribe, () => onlineStatus.connection === "offline");
  const why = offline ? "Ingen anslutning. Ladda om sidan när anslutningen är tillbaka." : "Tal till text kan ha uppdaterats sedan sidan öppnades. Ladda om sidan.";
  return (
    // What a reload gives back, said where the person decides: what the device keeps is not lost by it.
    <StandIn heading="Sidan kunde inte visas." text={`${why} Inspelningar som finns på enheten ligger kvar.`}>
      <Button label="Ladda om sidan" variant="primary" isDisabled={offline} onClick={() => window.location.reload()} />
      <Button label="Till startsidan" variant="secondary" href="/flows" />
    </StandIn>
  );
}

/** An address that is no page of the module: it says so, and the way to the start. */
export function NotFound() {
  return (
    <StandIn heading="Sidan finns inte." text="Kontrollera adressen, eller gå till startsidan.">
      <Button label="Till startsidan" variant="primary" href="/flows" />
    </StandIn>
  );
}
