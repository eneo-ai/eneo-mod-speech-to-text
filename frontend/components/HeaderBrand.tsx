import { Brand } from "@/components/Brand";

/**
 * The brand in a page's top bar (ModuleShell's `heading`): the organisation's mark and the product's name, a link to
 * the flows unless there is nothing to go back to.
 */
export function HeaderBrand({
  linked = true,
}: {
  /** Whether the brand links to the flows; not before sign-in, nor while leaving would abort an upload. */
  linked?: boolean;
}) {
  return <Brand href={linked ? "/flows" : undefined} />;
}
