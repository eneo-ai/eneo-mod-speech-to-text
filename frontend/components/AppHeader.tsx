import { AccountMenu } from "@/components/AccountMenu";
import { Brand } from "@/components/Brand";

export function AppHeader() {
  return (
    <header className="px-6 md:px-8 pt-5 pb-6 md:pt-7 flex items-center justify-between">
      <Brand href="/flows" />
      <AccountMenu />
    </header>
  );
}
