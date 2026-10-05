"use client";

import { Laptop, LogOut, Moon, Sun } from "lucide-react";
import { useContext, useState } from "react";
import { useNavigate } from "react-router";
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
import { useColorMode, type ColorMode } from "@/kit/ColorModeProvider";
import { logout } from "@/lib/api";
import { userDisplayName } from "@/lib/user-identity";

export function AccountMenu() {
  const navigate = useNavigate();
  const user = useAuthenticatedUser();
  const { mode, setMode } = useColorMode();
  const [loggingOut, setLoggingOut] = useState(false);
  const [failed, setFailed] = useState(false);
  const displayName = userDisplayName(user);
  // Signing out leaves the page: asked first where that would lose something.
  const { leaveFirst } = useContext(LeaveContext);

  async function onLogout() {
    setFailed(false);
    setLoggingOut(true);
    try {
      await logout();
    } catch {
      // Still signed in, and the sign-in page would send the person straight on to the flows: stay, and say so.
      setLoggingOut(false);
      setFailed(true);
      return;
    }
    void navigate("/", { replace: true });
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
      {/*
        Who is signed in: words to read, not something to choose. One line each, ending in an ellipsis when it is long:
        Astryx caps a menu at 300 px, and on a touch screen the rows alone (4 x 44 px) take most of it, so a longer
        identity would push Logga ut below the fold. The whole of it stays in the page's text and in the trigger's name.
      */}
      <Item
        density="compact"
        label={displayName}
        labelLines={1}
        description={user.email && displayName !== user.email ? user.email : undefined}
        descriptionLines={1}
      />

      <DropdownMenuDivider />
      {/* The group is named for assistive technology; the words above it are for the eye. */}
      <Text type="supporting" aria-hidden>
        Tema
      </Text>
      <DropdownMenuRadioGroup label="Tema" value={mode} onChange={(next) => setMode(next as ColorMode)}>
        <DropdownMenuRadioItem value="light" icon={Sun} label="Ljust" />
        <DropdownMenuRadioItem value="dark" icon={Moon} label="Mörkt" />
        <DropdownMenuRadioItem value="system" icon={Laptop} label="System" />
      </DropdownMenuRadioGroup>

      <DropdownMenuDivider />
      <DropdownMenuItem
        icon={loggingOut ? <Spinner size="sm" aria-hidden /> : LogOut}
        label={loggingOut ? "Loggar ut…" : failed ? "Det gick inte att logga ut. Försök igen." : "Logga ut"}
        isDisabled={loggingOut}
        // The menu stays open to say that it is signing out, and for the leave question to give back to.
        hasCloseOnSelect={false}
        onClick={() => leaveFirst(() => void onLogout())}
      />
    </DropdownMenu>
  );
}
