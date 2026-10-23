import { useLayoutEffect } from "react";

/**
 * The one owner of `data-workspace` on <html>: a view with the transcript beside its text (a result, the speakers'
 * review) is a workspace, whose page column grows with a wide window (styles/globals.css). Set before the first paint,
 * so the column never paints narrow and then widens; counted, so a view leaving while the next arrives keeps it.
 * An attribute on <html>, never a `:has()` over the page: one makes the browser check every element of a long
 * transcript again whenever its passages change.
 */
let workspaces = 0;

export function useWorkspace(on: boolean): void {
  useLayoutEffect(() => {
    if (!on) return;
    workspaces += 1;
    document.documentElement.setAttribute("data-workspace", "");
    return () => {
      workspaces -= 1;
      if (workspaces === 0) document.documentElement.removeAttribute("data-workspace");
    };
  }, [on]);
}
