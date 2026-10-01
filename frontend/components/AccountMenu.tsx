"use client";

import { Laptop, LogOut, Moon, Sun } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useContext, useEffect, useState } from "react";
import { Avatar } from "@astryxdesign/core/Avatar";
import {
  DropdownMenu,
  DropdownMenuDivider,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@astryxdesign/core/DropdownMenu";
import { Item } from "@astryxdesign/core/Item";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";

import { useAuthenticatedUser } from "@/components/AuthGate";
import { LeaveContext } from "@/components/flow/useLeaveQuestion";
import { logout } from "@/lib/api";
import { userDisplayName } from "@/lib/user-identity";

export function AccountMenu() {
  const router = useRouter();
  const user = useAuthenticatedUser();
  const { theme, setTheme } = useTheme();
  const [themeReady, setThemeReady] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const displayName = userDisplayName(user);
  // Signing out leaves the page: asked first where that would lose something.
  const { leaveFirst } = useContext(LeaveContext);

  useEffect(() => setThemeReady(true), []);

  async function onLogout() {
    setLoggingOut(true);
    try {
      await logout();
    } catch {
      // However the answer came, the page is left: the sign-in page says who is signed in.
    } finally {
      router.replace("/");
    }
  }

  // Not modal: a modal menu hides the page with aria-hidden while its links stay focusable (4.1.2).
  return (
    <DropdownMenu
      button={{
        label: `Öppna konto för ${displayName}`,
        isIconOnly: true,
        variant: "ghost",
        icon: <Avatar name={displayName} size="md" tooltip={false} />,
      }}
      hasChevron={false}
      alignment="end"
      menuWidth="18rem"
    >
      {/* Who is signed in: words to read, not something to choose. Long ones wrap, then end in an ellipsis. */}
      <Item
        density="spacious"
        label={displayName}
        labelLines={2}
        description={user.email && displayName !== user.email ? user.email : undefined}
        descriptionLines={2}
      />

      <DropdownMenuDivider />
      {/* The group is named for assistive technology; the words above it are for the eye. */}
      <Text type="supporting" aria-hidden>
        Tema
      </Text>
      <DropdownMenuRadioGroup label="Tema" value={themeReady ? theme : undefined} onChange={setTheme}>
        <DropdownMenuRadioItem value="light" icon={Sun} label="Ljust" isDisabled={!themeReady} />
        <DropdownMenuRadioItem value="dark" icon={Moon} label="Mörkt" isDisabled={!themeReady} />
        <DropdownMenuRadioItem value="system" icon={Laptop} label="System" isDisabled={!themeReady} />
      </DropdownMenuRadioGroup>

      <DropdownMenuDivider />
      <DropdownMenuItem
        icon={loggingOut ? <Spinner size="sm" aria-hidden /> : LogOut}
        label={loggingOut ? "Loggar ut…" : "Logga ut"}
        isDisabled={loggingOut}
        // The menu stays open to say that it is signing out, and for the leave question to give back to.
        hasCloseOnSelect={false}
        onClick={() => leaveFirst(() => void onLogout())}
      />
    </DropdownMenu>
  );
}
