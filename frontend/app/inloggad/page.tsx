import type { Metadata } from "next";
import { SignedInAgain, type Refusal } from "./SignedInAgain";

type Props = { searchParams: Promise<{ fel?: string | string[] }> };

const refusalOf = (fel: string | string[] | undefined): Refusal | null =>
  fel === "annan-anvandare" || fel === "utgangen" ? fel : null;

const TITLE: Record<Refusal | "ok", string> = {
  ok: "Inloggad igen · Tal till text",
  "annan-anvandare": "Fel användare · Tal till text",
  utgangen: "Inloggningen har gått ut · Tal till text",
};

// The title comes with the page: one set in the browser would lose to the layout's, which streams in after it.
export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  return { title: TITLE[refusalOf((await searchParams).fel) ?? "ok"] };
}

export default async function Page({ searchParams }: Props) {
  return <SignedInAgain refusal={refusalOf((await searchParams).fel)} />;
}
