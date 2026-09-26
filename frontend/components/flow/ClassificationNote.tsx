import { ShieldCheck } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { FlowSecurityClassification } from "@/lib/api";

/**
 * What information the flow may take: the classification of the flow's space,
 * its name and description as the organization wrote them. Without one Eneo
 * states no rule, so there is no row.
 */
export function ClassificationNote({ classification }: { classification?: FlowSecurityClassification | null }) {
  if (!classification) return null;
  return (
    <Alert role="note">
      <ShieldCheck aria-hidden />
      <AlertTitle>
        {classification.name}
      </AlertTitle>
      {classification.description && (
        <AlertDescription>
          {classification.description}
        </AlertDescription>
      )}
    </Alert>
  );
}
