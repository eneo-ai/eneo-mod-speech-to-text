"use client";

import { Laptop, Loader2, LogOut, Moon, Sun } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

import { useAuthenticatedUser } from "@/components/AuthGate";
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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Öppna konto för ${displayName}`}
          className="rounded-full p-0"
        >
          <Avatar>
            <AvatarFallback className="bg-accent text-[15px] font-semibold text-accent-foreground">
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
          {displayName !== user.email && (
            <span className="mt-0.5 block truncate text-xs text-ink-mute">
              {user.email}
            </span>
          )}
        </DropdownMenuLabel>

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="eyebrow-sm px-2.5 py-2 font-normal">
          Tema
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={themeReady ? theme : undefined}
          onValueChange={setTheme}
        >
          <DropdownMenuRadioItem value="light" disabled={!themeReady}>
            <Sun />
            Ljust
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark" disabled={!themeReady}>
            <Moon />
            Mörkt
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system" disabled={!themeReady}>
            <Laptop />
            System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={loggingOut}
          onSelect={() => void onLogout()}
        >
          {loggingOut ? <Loader2 className="animate-spin" /> : <LogOut />}
          {loggingOut ? "Loggar ut…" : "Logga ut"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
