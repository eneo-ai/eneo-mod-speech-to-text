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
import type { Branding } from "@/lib/api";
import { readBranding } from "@/lib/read-branding";
import { RouteEffects } from "@/routes/RouteEffects";

/** What every screen stands in: the colour mode and the design system's providers. */
function Providers({ children }: { children: ReactNode }) {
  return <ModuleProviders>{children}</ModuleProviders>;
}

/** Who the deployment is for, asked of the backend once; until it answers, or if it cannot, the product name alone. */
function useBranding(): Branding {
  const [branding, setBranding] = useState<Branding>({ organization: null });
  useEffect(() => {
    let current = true;
    void readBranding("").then((answer) => current && setBranding(answer));
    return () => {
      current = false;
    };
  }, []);
  return branding;
}

/** The frame of every page: its providers, the organisation, and the page the route names. */
export function Root() {
  const branding = useBranding();
  return (
    <Providers>
      <BrandingProvider value={branding}>
        <RouteEffects />
        <div data-app-shell>
          <Outlet />
        </div>
      </BrandingProvider>
    </Providers>
  );
}

/** While the first page's code arrives: the shell that every page shows while it asks who is signed in, so no frame is blank. */
export function RootHydrateFallback() {
  return (
    <Providers>
      <div data-app-shell>
        <LoadingShell />
      </div>
    </Providers>
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
    <ModuleShell label="Tal till text" heading={<Brand />}>
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
