import { useEffect, useState, type ReactNode } from "react";
import { Outlet, useRouteError } from "react-router";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { LoadingShell } from "@/components/LoadingShell";
import { Brand, BrandingProvider } from "@/components/Brand";
import { ModuleShell } from "@/kit/ModuleShell";
import { ModuleProviders } from "@/kit/ModuleProviders";
import { readBranding } from "@/lib/read-branding";
import { RouteEffects } from "@/routes/RouteEffects";
import { PRODUCT_NAME } from "@/lib/product";

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
 * A page that cannot be shown: its code could not be loaded (a tab that was open across a deploy asks for files that
 * are gone), or it threw. It stands in the page's place, inside the providers, and nothing reloads by itself: a person
 * may be in the middle of something on a page that is still open, and a reload is theirs to choose.
 */
export function RouteError() {
  const error = useRouteError();
  useEffect(() => console.error("A page could not be shown:", error), [error]);
  return (
    <ModuleShell label={PRODUCT_NAME} heading={<Brand />}>
      <VStack gap={4} maxWidth={640}>
        <Heading level={1}>Sidan kunde inte visas.</Heading>
        <Text as="p" color="secondary">
          Ladda om sidan.
        </Text>
        <HStack gap={3} wrap="wrap">
          <Button label="Ladda om sidan" variant="primary" onClick={() => window.location.reload()} />
          <Button label="Till startsidan" variant="secondary" href="/" />
        </HStack>
      </VStack>
    </ModuleShell>
  );
}
