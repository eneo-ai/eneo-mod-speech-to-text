"use client";

import { Laptop, Loader2, LogOut, Moon, Sun } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useContext, useEffect, useState } from "react";

import { useAuthenticatedUser } from "@/components/AuthGate";
import { LeaveContext } from "@/components/flow/useLeaveQuestion";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { logout } from "@/lib/api";
import { userDisplayName, userInitial } from "@/lib/user-identity";

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
    } finally {
      router.replace("/");
    }
  }

  return (
    // Not modal: a modal menu hides the page with aria-hidden while its links stay focusable (4.1.2).
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Öppna konto för ${displayName}`}
          className="shrink-0 rounded-full p-0"
        >
          <Avatar>
            <AvatarFallback className="bg-primary text-[15px] font-semibold text-primary-foreground">
              {userInitial(user)}
            </AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" sideOffset={8} className="w-72">
        <DropdownMenuLabel className="min-w-0 px-2.5 py-2 font-normal">
          <span className="block truncate text-sm font-semibold text-ink">
            {displayName}
          </span>
          {user.email && displayName !== user.email && (
            <span className="mt-0.5 block truncate text-xs text-ink-mute">
              {user.email}
            </span>
          )}
        </DropdownMenuLabel>

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="px-2.5 py-2 text-xs font-normal text-ink-mute">
          Tema
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={themeReady ? theme : undefined}
          onValueChange={setTheme}
        >
          <DropdownMenuRadioItem value="light" disabled={!themeReady}>
            <Sun aria-hidden />
            Ljust
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark" disabled={!themeReady}>
            <Moon aria-hidden />
            Mörkt
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system" disabled={!themeReady}>
            <Laptop aria-hidden />
            System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={loggingOut}
          onSelect={() => leaveFirst(() => void onLogout())}
        >
          {loggingOut ? <Loader2 aria-hidden className="animate-spin" /> : <LogOut aria-hidden />}
          {loggingOut ? "Loggar ut…" : "Logga ut"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
