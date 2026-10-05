"use client";

import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { VStack } from "@astryxdesign/core/VStack";
import { FlowFrame } from "@/components/flow/FlowFrame";
import { BackToFlows } from "@/components/flow/BackToFlows";
import { useDocumentTitle } from "@/components/flow/recording-hooks";
import { ApiError } from "@/lib/api";
import { errorAdvice } from "@/lib/errors";
import { documentTitle } from "@/lib/product";

/** The flow page's shape while it loads, so nothing moves when it arrives. */
export function FlowSkeleton() {
  return (
    <FlowFrame
      aside={
        <VStack gap={5} aria-busy="true">
          <Skeleton width="75%" height={28} />
          <VStack gap={2}>
            <Skeleton width="100%" height={16} />
            <Skeleton width="66%" height={16} />
          </VStack>
          <Skeleton width="100%" height={48} />
          <Skeleton width={128} height={16} />
          <Skeleton width="100%" height={80} />
        </VStack>
      }
    >
      <VisuallyHidden as="p" role="status">
        Laddar flödet…
      </VisuallyHidden>
      <VStack gap={3} aria-busy="true">
        <Skeleton width={224} height={24} />
        {[0, 1, 2].map((card) => (
          <Skeleton key={card} index={card} width="100%" height={76} />
        ))}
        <Skeleton width="100%" height={48} />
      </VStack>
    </FlowFrame>
  );
}

/** What the page says when the flow cannot be opened; "Försök igen" only where trying again can help. */
export function unavailableCopy(error: unknown): { title: string; detail: string; retry: boolean } {
  if (error instanceof ApiError && (error.status === 404 || error.code === "flow_not_published")) {
    return {
      title: "Flödet är inte längre tillgängligt.",
      detail: "Det kan ha avpublicerats eller tagits bort. Välj ett annat flöde.",
      retry: false,
    };
  }
  const { message, retry, ownerMustFix } = errorAdvice(error);
  return { title: ownerMustFix ? "Flödet kan inte användas just nu." : "Flödet kunde inte laddas.", detail: message, retry };
}

/** The flow could not be loaded: unpublished (404) or another failure, with a way on. */
export function FlowUnavailable({ error }: { error: unknown }) {
  const { title, detail, retry } = unavailableCopy(error);
  useDocumentTitle(documentTitle(title.replace(/\.$/, "")));
  return (
    <FlowFrame>
      {/* A reading column on the frame's left edge, like the flow's own column beside the card. */}
      <VStack gap={4} maxWidth={640}>
        <Heading level={1}>{title}</Heading>
        <Text as="p" color="secondary">
          {detail}
        </Text>
        <HStack gap={3} wrap="wrap">
          <BackToFlows variant="default" size="default" />
          {retry && <Button label="Försök igen" variant="secondary" onClick={() => window.location.reload()} />}
        </HStack>
      </VStack>
    </FlowFrame>
  );
}
